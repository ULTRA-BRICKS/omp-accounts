/**
 * accounts — multi-OAuth-account management for omp.
 *
 * Installed as an omp plugin (`omp plugin install github:alex-mextner/omp-accounts`)
 * or dropped into ~/.omp/agent/extensions/accounts/ for native auto-discovery.
 *
 * Provides the /accounts slash command (list/set/unset/rotation/login/logout/ceiling),
 * an optional max-remaining-quota rotation policy applied on turn_start, per-model
 * quota ceilings with automatic fallback-model switching, and a notification when the
 * session's active account changes underneath you (native auto-rotation).
 *
 * Configuration lives in <agent dir>/accounts.config.json (see CONFIG_PATH below).
 * Runtime requirements: omp >= 18.1.15 (AuthStorage.listOAuthAccounts /
 * pinSessionOAuthAccount / releaseSessionCredentialForReselection / getModelUsageHealth).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

// ---------------------------------------------------------------------------
// Minimal structural types for the AuthStorage surface we use (public API,
// re-declared here so the extension stays self-contained).
// ---------------------------------------------------------------------------

export interface OAuthAccountSummary {
	position: number;
	credentialId: number;
	accountId?: string;
	email?: string;
	orgId?: string;
	orgName?: string;
	active: boolean;
}

interface ModelUsageAccountHealth {
	credentialId: number;
	credentialType: string;
	selected?: true;
	state: "healthy" | "reserve" | "depleted" | "unknown";
	remainingFraction?: number;
	resetsAt?: number;
}

interface ModelUsageHealth {
	state: "healthy" | "reserve" | "depleted" | "unknown";
	accounts: ModelUsageAccountHealth[];
}

interface AuthStorageLike {
	listOAuthAccounts(provider: string, sessionId?: string): OAuthAccountSummary[];
	pinSessionOAuthAccount(provider: string, sessionId: string, credentialId: number): boolean;
	releaseSessionCredentialForReselection(provider: string, sessionId: string): boolean;
	getOAuthAccountIdentity(
		provider: string,
		sessionId?: string,
	): { accountId?: string; email?: string; projectId?: string; orgName?: string } | undefined;
	getModelUsageHealth(
		provider: string,
		options: { modelId?: string; sessionId?: string; baseUrl?: string; reserveFraction: number },
	): Promise<ModelUsageHealth>;
	removeCredential(provider: string, credentialId: number): Promise<boolean>;
	describeCredentialSource?(provider: string, sessionId?: string): string | undefined;
	list?(): string[];
}

// ---------------------------------------------------------------------------
// Config: <agent dir>/accounts.config.json wins; falls back to a file next to
// this module (legacy drop-in installs). The agent dir is PI_CODING_AGENT_DIR
// or ~/.omp/agent.
// ---------------------------------------------------------------------------

interface ModelCeilingRule {
	/** Switch away when the active account's used fraction exceeds this (0..1). Default 0.9. */
	maxUsedFraction: number;
	/** Fallback model spec ("provider/model-id" or bare id) to switch to. */
	fallback?: string;
}

export type RotationPolicy = "default" | "smart";

interface AccountsConfig {
	rotationPolicy: RotationPolicy;
	/** Reserve fraction passed to getModelUsageHealth. Default 0.1. */
	reserveFraction: number;
	/**
	 * Hysteresis margin for rotation: re-pin only when the best account's
	 * remaining fraction beats the active one's by more than this. Prevents
	 * oscillation that would cold-start the Anthropic prompt cache. Default 0.1.
	 */
	rotationMargin: number;
	/** Per-model ceiling rules keyed by model id or "provider/model-id". */
	models: Record<string, ModelCeilingRule>;
}

const MODULE_CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "accounts.config.json");
const USER_CONFIG_PATH = path.join(process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".omp", "agent"), "accounts.config.json");
// Packaged installs ship no config in the module dir, so reads and `rotation on|off`
// persistence land in the stable agent-dir location; drop-in installs with a config
// next to the module keep their historical file.
const CONFIG_PATH = existsSync(USER_CONFIG_PATH) || !existsSync(MODULE_CONFIG_PATH) ? USER_CONFIG_PATH : MODULE_CONFIG_PATH;
const CONFIG_FILE_EXISTED = existsSync(CONFIG_PATH);


/** Resolve rotation policy from raw JSON with migration from legacy `rotation` boolean. */
export function normalizeRotationPolicy(raw: Record<string, unknown>, configFileExisted: boolean): RotationPolicy {
	if (raw.rotationPolicy === "smart" || raw.rotationPolicy === "default") {
		return raw.rotationPolicy;
	}
	if (raw.rotation === true) return "smart";
	if (raw.rotation === false) return "default";
	return configFileExisted ? "default" : "smart";
}

export interface RotationModeParse {
	policy?: RotationPolicy;
	deprecated?: string;
	error?: string;
}

export function parseRotationMode(mode: string): RotationModeParse {
	const lower = mode.trim().toLowerCase();
	if (lower === "smart" || lower === "default") return { policy: lower as RotationPolicy };
	if (lower === "on") return { policy: "smart", deprecated: '"on" is deprecated — use "smart" (max-remaining-quota pin each turn)' };
	if (lower === "off") return { policy: "default", deprecated: '"off" is deprecated — use "default" (built-in omp rotation)' };
	return { error: "Usage: /accounts rotation default|smart|status" };
}

function parseModels(raw: Record<string, unknown>): Record<string, ModelCeilingRule> {
	const models: Record<string, ModelCeilingRule> = {};
	if (!raw.models || typeof raw.models !== "object") return models;
	for (const [key, value] of Object.entries(raw.models as Record<string, unknown>)) {
		if (typeof value === "number" && Number.isFinite(value)) {
			models[key] = { maxUsedFraction: value };
			continue;
		}
		if (value && typeof value === "object") {
			const obj = value as Record<string, unknown>;
			models[key] = {
				maxUsedFraction:
					typeof obj.maxUsedFraction === "number" && Number.isFinite(obj.maxUsedFraction) ? obj.maxUsedFraction : 0.9,
				fallback: typeof obj.fallback === "string" && obj.fallback.trim() ? obj.fallback.trim() : undefined,
			};
		}
	}
	return models;
}

function saveConfig(config: AccountsConfig): void {
	const payload = {
		rotationPolicy: config.rotationPolicy,
		reserveFraction: config.reserveFraction,
		rotationMargin: config.rotationMargin,
		models: config.models,
	};
	writeFileSync(CONFIG_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function loadConfig(): AccountsConfig {
	const fallback: AccountsConfig = {
		rotationPolicy: normalizeRotationPolicy({}, CONFIG_FILE_EXISTED),
		reserveFraction: 0.1,
		rotationMargin: 0.1,
		models: {},
	};
	if (!CONFIG_FILE_EXISTED) return fallback;
	try {
		const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;
		return {
			rotationPolicy: normalizeRotationPolicy(raw, true),
			reserveFraction:
				typeof raw.reserveFraction === "number" && raw.reserveFraction >= 0 && raw.reserveFraction < 1
					? raw.reserveFraction
					: 0.1,
			rotationMargin:
				typeof raw.rotationMargin === "number" && raw.rotationMargin >= 0 && raw.rotationMargin < 1
					? raw.rotationMargin
					: 0.1,
			models: parseModels(raw),
		};
	} catch {
		return fallback;
	}
}

const config = loadConfig();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Ctx = ExtensionContext | ExtensionCommandContext;

function authOf(ctx: Ctx): AuthStorageLike {
	return ctx.modelRegistry.authStorage as unknown as AuthStorageLike;
}

/** Command/status output: UI notification in interactive mode, stderr otherwise. */
function say(ctx: Ctx, text: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(text, type);
	} else {
		process.stderr.write(`[accounts] ${text}\n`);
	}
}

function isRedundantOrgName(org: string, email: string): boolean {
	return org === `${email}'s Organization` || org === `${email}'s organisation`;
}

/** Best-effort readable label: email → orgName (if meaningful) → accountId → credential id. */
export function accountLabel(account: OAuthAccountSummary): string {
	if (account.email) {
		const org = account.orgName?.trim();
		if (org && !isRedundantOrgName(org, account.email)) return `${account.email} (${org})`;
		return account.email;
	}
	const org = account.orgName?.trim();
	if (org) return org;
	if (account.accountId) return account.accountId;
	return `credential ${account.credentialId}`;
}

function identityLabel(identity: { email?: string; accountId?: string; orgName?: string } | undefined): string {
	if (!identity) return "none resolved yet";
	if (identity.email) {
		const org = identity.orgName?.trim();
		if (org && !isRedundantOrgName(org, identity.email)) return `${identity.email} (${org})`;
		return identity.email;
	}
	if (identity.orgName?.trim()) return identity.orgName.trim();
	return identity.accountId ?? "unknown";
}

function formatPercent(fraction: number): string {
	return `${Math.round(fraction * 100)}%`;
}

function describeUsage(usage: ModelUsageAccountHealth | undefined): string {
	if (!usage) return "";
	if (usage.remainingFraction !== undefined) {
		const resets = usage.resetsAt ? `, resets ${new Date(usage.resetsAt).toLocaleTimeString()}` : "";
		return ` — ${formatPercent(usage.remainingFraction)} remaining${resets}`;
	}
	return usage.state === "unknown" ? "" : ` — ${usage.state}`;
}

/** Used fraction (0..1) of one account's health entry; undefined when unknown. */
function usedFractionOf(entry: ModelUsageAccountHealth): number | undefined {
	if (entry.remainingFraction !== undefined) return 1 - entry.remainingFraction;
	return entry.state === "depleted" ? 1 : undefined;
}


function providersWithStoredAccounts(ctx: Ctx, auth: AuthStorageLike): string[] {
	const providers = new Set<string>();
	try {
		for (const model of ctx.models.list()) providers.add(model.provider);
	} catch {
		// best-effort
	}
	try {
		for (const p of auth.list?.() ?? []) providers.add(p);
	} catch {
		// best-effort
	}
	const sessionId = ctx.sessionManager.getSessionId();
	const result: string[] = [];
	for (const provider of providers) {
		try {
			if (auth.listOAuthAccounts(provider, sessionId).length > 0) result.push(provider);
		} catch {
			// skip
		}
	}
	return result.sort();
}

const ROTATION_SMART_ASCII = [
	"Smart rotation (10% hysteresis margin):",
	"  Turn1: A(80%) → pin A",
	"  Turn2: B(90%) → stay A  (90% ≤ 80%+10%)",
	"  Turn3: B(95%) → pin B   (95% > 80%+10%)",
].join("\n");

const ROTATION_DEFAULT_ASCII = [
	"Default rotation (built-in omp):",
	"  omp ranks accounts by required drain / stickiness",
	"  Use /accounts set to override for this session",
].join("\n");

const CEILING_ASCII = [
	"Ceiling example (90% used → fallback):",
	"  opus:  █████████░ 92% used → switch to sonnet",
	"  sonnet: ████░░░░░░ 40% used → stay",
].join("\n");
function resolveAccount(
	accounts: OAuthAccountSummary[],
	selector: string,
): { account?: OAuthAccountSummary; error?: string } {
	const trimmed = selector.trim();
	if (/^\d+$/.test(trimmed)) {
		const position = Number.parseInt(trimmed, 10) - 1;
		const account = accounts.find(a => a.position === position);
		return account ? { account } : { error: `No account #${trimmed}.` };
	}
	const wanted = trimmed.toLowerCase();
	const exact = accounts.filter(a => a.email?.toLowerCase() === wanted || a.accountId?.toLowerCase() === wanted);
	const matches =
		exact.length > 0
			? exact
			: accounts.filter(
					a => a.email?.toLowerCase().includes(wanted) || a.accountId?.toLowerCase().includes(wanted),
				);
	if (matches.length === 0) return { error: `No account matches "${trimmed}".` };
	if (matches.length > 1) {
		return {
			error: `"${trimmed}" matches multiple accounts: ${matches
				.map(a => `${a.position + 1}. ${accountLabel(a)}`)
				.join(", ")}. Use the account number.`,
		};
	}
	return { account: matches[0] };
}

interface SubcommandSpec {
	name: string;
	description: string;
	/** Dim ghost-hint shown inline after the cursor while the item is selected. */
	usage?: string;
}

const SUBCOMMANDS: SubcommandSpec[] = [
	{ name: "list", description: "Show OAuth accounts with quota (current provider expanded; others summarized)", usage: "[provider|all]" },
	{ name: "set", description: "Pin one account for this session — keeps prompt cache warm on Anthropic", usage: "<n|email|accountId>" },
	{ name: "unset", description: "Release the pin; built-in omp rotation resumes for this session" },
	{ name: "auto", description: "Alias for unset — hand control back to omp" },
	{ name: "rotation", description: "Rotation policy: default (built-in omp) or smart (max remaining quota)", usage: "default|smart|status" },
	{ name: "login", description: "Start OAuth login — pre-fills /login so you only press Enter", usage: "[provider]" },
	{ name: "logout", description: "Remove a stored OAuth account from disk (interactive picker without args)", usage: "[n|email|accountId]" },
	{ name: "ceiling", description: "Per-model quota ceilings — switch to a fallback model before hard limits", usage: "set <model> <percent> [fallback] | unset <model>" },
	{ name: "help", description: "Show command reference with use cases" },
];

const HELP_TEXT = [
	"OAuth account management — CLI-first; config file is storage only.",
	"",
	...SUBCOMMANDS.map(s => `/accounts ${s.name}${s.usage ? ` ${s.usage}` : ""} — ${s.description}`),
	"",
	ROTATION_SMART_ASCII,
	"",
	CEILING_ASCII,
	"",
	"Tab-completion: subcommands, accounts for set|logout, default|smart|status for rotation.",
	"Providers with stored OAuth accounts + 'all' for list.",
].join("\n");

/**
 * Structural mirror of pi-tui's AutocompleteItem. pi-coding-agent imports the
 * type but does not re-export it, and this extension stays self-contained.
 */
interface CompletionItem {
	value: string;
	label: string;
	description?: string;
	hint?: string;
}

/** Remaining fraction (0..1) of a health entry, with state-based fallback. */
function remainingOf(entry: ModelUsageAccountHealth): number {
	return entry.remainingFraction ?? (entry.state === "healthy" ? 1 : 0);
}

export interface RotationVerdict {
	pin: boolean;
	reason: "no-active" | "active-depleted" | "margin-exceeded" | "within-margin" | "already-best";
	activeRemaining?: number;
	bestRemaining: number;
}

/**
 * Hysteresis decision for rotation (pure, exported for testing): re-pin only
 * when the best account beats the active one by more than the margin, so
 * near-ties don't oscillate and cold-start the Anthropic prompt cache.
 * A depleted active account is always abandoned — never strand a session on
 * a dead account. With no active account, pin the best unconditionally.
 */
export function decideRotation(
	active: ModelUsageAccountHealth | undefined,
	best: ModelUsageAccountHealth,
	margin: number,
): RotationVerdict {
	const bestRemaining = remainingOf(best);
	if (!active || active.credentialId === best.credentialId) {
		return {
			pin: !active,
			reason: active ? "already-best" : "no-active",
			activeRemaining: active ? remainingOf(active) : undefined,
			bestRemaining,
		};
	}
	const activeRemaining = remainingOf(active);
	if (active.state === "depleted") {
		return { pin: true, reason: "active-depleted", activeRemaining, bestRemaining };
	}
	if (bestRemaining > activeRemaining + margin) {
		return { pin: true, reason: "margin-exceeded", activeRemaining, bestRemaining };
	}
	return { pin: false, reason: "within-margin", activeRemaining, bestRemaining };
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------


function rotationStatusText(config: AccountsConfig, identity?: { email?: string; accountId?: string; orgName?: string }): string {
	const policyLine =
		config.rotationPolicy === "smart"
			? "Rotation: smart (max remaining quota)"
			: "Rotation: default (built-in omp)";
	const diagram = config.rotationPolicy === "smart" ? ROTATION_SMART_ASCII : ROTATION_DEFAULT_ASCII;
	return [
		policyLine,
		`Hysteresis margin: ${formatPercent(config.rotationMargin)} (depleted active account always rotates)`,
		`Active account: ${identityLabel(identity)}`,
		"",
		diagram,
		"",
		`Config: ${CONFIG_PATH}`,
	].join("\n");
}

/**
 * Second-level completions for a known subcommand.
 * Workaround for TUI bug: first Space after subcommand may not reopen the dropdown
 * (packages/tui/src/components/editor.ts #isSlashCommandNameAutocompleteSelection only
 * chains when textBeforeCursor has no space yet). When the prefix exactly matches a
 * subcommand name, return argument completions here too.
 */
export default function accountsExtension(pi: ExtensionAPI) {
	pi.setLabel("Accounts");

	/** Last known active-account key per "sessionId:provider", for switch detection. */
	const lastActiveBySession = new Map<string, string>();
	/** Accounts we pinned ourselves: suppresses the external-rotation notification once. */
	const selfPinnedBySession = new Map<string, string>();

	// -- /accounts argument completion ------------------------------------------
	// getArgumentCompletions receives no ctx and must return synchronously, so
	// completion reads this cache; it is refreshed from session events and after
	// every /accounts run.
	const completionCache = {
		currentProvider: undefined as string | undefined,
		providers: new Set<string>(),
		loggedInProviders: [] as string[],
		accountsByProvider: new Map<string, OAuthAccountSummary[]>(),
		modelIds: [] as string[],
	};

	function refreshCompletionCache(ctx: Ctx): void {
		const provider = ctx.model?.provider;
		const auth = authOf(ctx);
		if (provider) {
			completionCache.currentProvider = provider;
			completionCache.providers.add(provider);
		}
		try {
			for (const model of ctx.models.list()) {
				completionCache.providers.add(model.provider);
				if (!completionCache.modelIds.includes(model.id)) completionCache.modelIds.push(model.id);
			}
		} catch {
			// model listing is best-effort for completion only
		}
		completionCache.loggedInProviders = providersWithStoredAccounts(ctx, auth);
		if (!provider) return;
		try {
			completionCache.accountsByProvider.set(
				provider,
				auth.listOAuthAccounts(provider, ctx.sessionManager.getSessionId()),
			);
		} catch {
			// keep the stale cache
		}
	}

	function completeSubcommandArgs(
		sub: string,
		argPrefix: string,
		cache: {
			currentProvider?: string;
			providers: Set<string>;
			loggedInProviders: string[];
			modelIds: string[];
		},
	): CompletionItem[] | null {
		const lowerArg = argPrefix.toLowerCase();
		if (sub === "rotation") {
			const modes = [
				{ name: "default", description: "Built-in omp quota-aware rotation", hint: "native ranker" },
				{ name: "smart", description: "Pin max-remaining account each turn (10% hysteresis)", hint: "max quota" },
				{ name: "status", description: "Show rotation policy, margin, and active account" },
			].filter(m => m.name.startsWith(lowerArg));
			return modes.length > 0
				? modes.map(m => ({ value: `rotation ${m.name} `, label: m.name, description: m.description, hint: m.hint }))
				: null;
		}
		if (sub === "ceiling") {
			if (!lowerArg) {
				return [
					{ value: "ceiling set ", label: "set", description: "Add or update a per-model ceiling rule" },
					{ value: "ceiling unset ", label: "unset", description: "Remove a ceiling rule for one model" },
				];
			}
			if (lowerArg.startsWith("set")) {
				const rest = argPrefix.slice(3).trimStart();
				const parts = rest.split(/\s+/).filter(Boolean);
				if (parts.length === 0) {
					return cache.modelIds.map(id => ({ value: `ceiling set ${id} `, label: id, description: "model to cap" }));
				}
				if (parts.length === 1) {
					return ["80", "85", "90", "95"].map(p => ({
						value: `ceiling set ${parts[0]} ${p} `,
						label: `${p}%`,
						description: `switch when > ${p}% of quota is used`,
					}));
				}
			}
			if (lowerArg.startsWith("unset")) {
				const modelPart = argPrefix.slice(5).trimStart().toLowerCase();
				return cache.modelIds
					.filter(id => !modelPart || id.toLowerCase().includes(modelPart))
					.map(id => ({ value: `ceiling unset ${id} `, label: id, description: "remove ceiling" }));
			}
		}
		if (sub === "list") {
			const providers = ["all", ...cache.loggedInProviders].filter(p => p.startsWith(lowerArg)).sort();
			return providers.length > 0
				? providers.map(p => ({
						value: `list ${p} `,
						label: p,
						description: p === "all" ? "all logged-in providers expanded" : p === cache.currentProvider ? "current provider" : "stored OAuth accounts",
					}))
				: null;
		}
		if (sub === "login") {
			const providers = [...cache.providers].filter(p => p.startsWith(lowerArg)).sort();
			return providers.length > 0
				? providers.map(p => ({ value: `login ${p} `, label: p, description: p === cache.currentProvider ? "current provider" : undefined }))
				: null;
		}
		return null;
	}

	function completeAccountsArgument(argumentPrefix: string): CompletionItem[] | null {
		const spaceIndex = argumentPrefix.indexOf(" ");
		if (spaceIndex === -1) {
			const lower = argumentPrefix.toLowerCase();
			const exact = SUBCOMMANDS.find(s => s.name === lower);
			if (exact) {
				const nested = completeSubcommandArgs(exact.name, "", completionCache);
				if (nested) return nested;
			}
			const matches = SUBCOMMANDS.filter(s => s.name.startsWith(lower)).map(s => ({
				value: `${s.name} `,
				label: s.name,
				description: s.description,
				hint: s.usage,
			}));
			return matches.length > 0 ? matches : null;
		}
		const sub = argumentPrefix.slice(0, spaceIndex).toLowerCase();
		const argPrefix = argumentPrefix.slice(spaceIndex + 1);
		const nested = completeSubcommandArgs(sub, argPrefix, completionCache);
		if (nested) return nested;
		if (argPrefix.includes(" ")) return null;
		const lowerArg = argPrefix.toLowerCase();
		if (sub === "set" || sub === "logout") {
			const provider = completionCache.currentProvider;
			const accounts = provider ? (completionCache.accountsByProvider.get(provider) ?? []) : [];
			if (accounts.length === 0) return null;
			const matches = accounts.filter(a => {
				if (!lowerArg) return true;
				return (
					String(a.position + 1).startsWith(lowerArg) ||
					(a.email?.toLowerCase().includes(lowerArg) ?? false) ||
					(a.accountId?.toLowerCase().includes(lowerArg) ?? false)
				);
			});
			return matches.length > 0
				? matches.map(a => ({
						value: `${sub} ${a.position + 1} `,
						label: `${a.position + 1}. ${accountLabel(a)}`,
						description: a.active ? "active" : undefined,
					}))
				: null;
		}
		return null;
	}

	function activeIdentityKey(ctx: Ctx, provider: string): string | undefined {
		const identity = authOf(ctx).getOAuthAccountIdentity(provider, ctx.sessionManager.getSessionId());
		return identity ? (identity.email ?? identity.accountId) : undefined;
	}

	function rememberIdentity(ctx: Ctx, provider: string): void {
		const current = activeIdentityKey(ctx, provider);
		if (current) lastActiveBySession.set(`${ctx.sessionManager.getSessionId()}:${provider}`, current);
	}

	/** Notify when the active account changed without this extension pinning it. */
	function detectAccountSwitch(ctx: Ctx, provider: string): void {
		const key = `${ctx.sessionManager.getSessionId()}:${provider}`;
		const current = activeIdentityKey(ctx, provider);
		if (!current) return;
		const previous = lastActiveBySession.get(key);
		lastActiveBySession.set(key, current);
		if (previous === undefined || previous === current) return;
		if (selfPinnedBySession.get(key) === current) {
			selfPinnedBySession.delete(key);
			return;
		}
		say(ctx, `Account switched: ${previous} → ${current} (auto-rotation)`);
	}

	async function usageByCredential(
		ctx: Ctx,
		provider: string,
	): Promise<Map<number, ModelUsageAccountHealth> | undefined> {
		const model = ctx.model;
		try {
			const health = await authOf(ctx).getModelUsageHealth(provider, {
				modelId: model?.id,
				baseUrl: model?.baseUrl,
				sessionId: ctx.sessionManager.getSessionId(),
				reserveFraction: config.reserveFraction,
			});
			return new Map(health.accounts.map(a => [a.credentialId, a]));
		} catch {
			return undefined;
		}
	}

	/** Pin the OAuth account with the highest remaining fraction, subject to the rotation margin. */
	async function applyRotation(ctx: Ctx, provider: string, reason: string): Promise<void> {
		const sessionId = ctx.sessionManager.getSessionId();
		const auth = authOf(ctx);
		const accounts = auth.listOAuthAccounts(provider, sessionId);
		if (accounts.length < 2) return;
		const usage = await usageByCredential(ctx, provider);
		if (!usage) return;
		let best: OAuthAccountSummary | undefined;
		let bestEntry: ModelUsageAccountHealth | undefined;
		let bestRemaining = -1;
		for (const account of accounts) {
			const entry = usage.get(account.credentialId);
			if (!entry || entry.credentialType !== "oauth" || entry.state === "depleted") continue;
			const remaining = remainingOf(entry);
			if (remaining > bestRemaining) {
				bestRemaining = remaining;
				best = account;
				bestEntry = entry;
			}
		}
		if (!best || !bestEntry) return;
		const active = accounts.find(a => a.active);
		const verdict = decideRotation(active ? usage.get(active.credentialId) : undefined, bestEntry, config.rotationMargin);
		if (!verdict.pin) return;
		if (!auth.pinSessionOAuthAccount(provider, sessionId, best.credentialId)) return;
		const bestKey = best.email ?? best.accountId;
		if (bestKey) {
			const key = `${sessionId}:${provider}`;
			selfPinnedBySession.set(key, bestKey);
			lastActiveBySession.set(key, bestKey);
		}
		const detail =
			verdict.activeRemaining !== undefined
				? `${formatPercent(verdict.bestRemaining)} vs active ${formatPercent(verdict.activeRemaining)} remaining (margin ${formatPercent(config.rotationMargin)})`
				: `${formatPercent(verdict.bestRemaining)} remaining`;
		say(ctx, `Rotation (${reason}, ${verdict.reason}): pinned ${accountLabel(best)} — ${detail}`);
	}

	/** Switch to the configured fallback model when the current model's quota is past its ceiling. */
	async function applyCeiling(ctx: Ctx): Promise<void> {
		const model = ctx.model;
		if (!model) return;
		const rule = config.models[model.id] ?? config.models[`${model.provider}/${model.id}`];
		if (!rule?.fallback) return;
		let health: ModelUsageHealth;
		try {
			health = await authOf(ctx).getModelUsageHealth(model.provider, {
				modelId: model.id,
				baseUrl: model.baseUrl,
				sessionId: ctx.sessionManager.getSessionId(),
				reserveFraction: config.reserveFraction,
			});
		} catch {
			return;
		}
		// Judge by the session's selected account; when none is resolved yet, be
		// conservative and use the most-exhausted account.
		const selected = health.accounts.find(a => a.selected);
		let used = selected ? usedFractionOf(selected) : undefined;
		if (used === undefined && !selected) {
			for (const entry of health.accounts) {
				const candidate = usedFractionOf(entry);
				if (candidate !== undefined && (used === undefined || candidate > used)) used = candidate;
			}
		}
		if (used === undefined || used <= rule.maxUsedFraction) return;
		const fallbackSpec = rule.fallback;
		if (fallbackSpec === model.id || fallbackSpec === `${model.provider}/${model.id}`) return;
		const fallback = ctx.models.resolve(fallbackSpec);
		if (!fallback) {
			say(ctx, `Ceiling: fallback model "${fallbackSpec}" not resolvable; staying on ${model.id}.`, "warning");
			return;
		}
		const ok = await pi.setModel(fallback);
		if (ok) {
			say(
				ctx,
				`Ceiling: ${model.id} at ${formatPercent(used)} used (> ${formatPercent(rule.maxUsedFraction)}); switched to ${fallback.id}.`,
				"warning",
			);
		}
	}


	async function formatProviderList(ctx: Ctx, provider: string): Promise<string[]> {
		const auth = authOf(ctx);
		const sessionId = ctx.sessionManager.getSessionId();
		const accounts = auth.listOAuthAccounts(provider, sessionId);
		if (accounts.length === 0) {
			const source = auth.describeCredentialSource?.(provider, sessionId);
			return source
				? [`No stored OAuth accounts for ${provider}. Current auth comes from ${source}.`]
				: [`No stored OAuth accounts for ${provider}. Use /login to add one.`];
		}
		const usage = await usageByCredential(ctx, provider);
		const lines = [`OAuth accounts for ${provider}:`];
		for (const account of accounts) {
			lines.push(
				`${account.position + 1}. ${accountLabel(account)}${account.active ? " (active)" : ""}${describeUsage(usage?.get(account.credentialId))}`,
			);
		}
		lines.push("", "Pin one with /accounts set <number|email|account id>.");
		return lines;
	}

	async function showCeilingStatus(ctx: Ctx): Promise<void> {
		const lines = [
			"Per-model quota ceilings — switch to a cheaper/fallback model before you hit hard limits.",
			"Use: /accounts ceiling set <model> <percent> [fallback]  |  unset <model>",
			"",
			CEILING_ASCII,
			"",
		];
		const entries = Object.entries(config.models);
		if (entries.length === 0) {
			lines.push("No ceilings configured yet. Example:");
			lines.push("  /accounts ceiling set claude-opus-4-6 90 anthropic/claude-sonnet-4-6");
			say(ctx, lines.join("\n"));
			return;
		}
		lines.push("Configured rules (live quota when available):");
		for (const [modelKey, rule] of entries) {
			const resolved = ctx.models.resolve(modelKey);
			let live = "";
			if (resolved) {
				try {
					const health = await authOf(ctx).getModelUsageHealth(resolved.provider, {
						modelId: resolved.id,
						baseUrl: resolved.baseUrl,
						sessionId: ctx.sessionManager.getSessionId(),
						reserveFraction: config.reserveFraction,
					});
					const selected = health.accounts.find(a => a.selected);
					const used = selected ? usedFractionOf(selected) : undefined;
					if (used !== undefined) {
						const bar = used >= rule.maxUsedFraction ? "OVER" : "ok";
						live = ` — active ${formatPercent(used)} used [${bar}]`;
					}
				} catch {
					// skip live line
				}
			}
			lines.push(
				`- ${modelKey}: switch at > ${formatPercent(rule.maxUsedFraction)} used${rule.fallback ? ` → ${rule.fallback}` : ""}${live}`,
			);
		}
		lines.push("", `Persisted in ${CONFIG_PATH}`);
		say(ctx, lines.join("\n"));
	}

	// -- events ---------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		refreshCompletionCache(ctx);
		if (ctx.model?.provider) rememberIdentity(ctx, ctx.model.provider);
	});

	pi.on("session_switch", async (_event, ctx) => {
		refreshCompletionCache(ctx);
		if (ctx.model?.provider) rememberIdentity(ctx, ctx.model.provider);
	});

	pi.on("turn_start", async (_event, ctx) => {
		refreshCompletionCache(ctx);
		const provider = ctx.model?.provider;
		if (!provider) return;
		detectAccountSwitch(ctx, provider);
		if (config.rotationPolicy === "smart") await applyRotation(ctx, provider, "turn_start");
		await applyCeiling(ctx);
	});

	pi.on("credential_disabled", async (event, ctx) => {
		say(ctx, `Credential disabled for ${event.provider}: ${event.disabledCause}`, "warning");
	});

	// -- /accounts command ----------------------------------------------------

	pi.registerCommand("accounts", {
		description: "Manage OAuth accounts: list, pin, rotation policy, quota ceilings",
		getArgumentCompletions: completeAccountsArgument,
		handler: async (args, ctx) => {
			refreshCompletionCache(ctx);
			const [sub = "list", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const restArgs = rest.join(" ");

			switch (sub) {
				case "list": {
					const auth = authOf(ctx);
					const query = restArgs.trim();
					const queryLower = query.toLowerCase();

					if (queryLower === "all") {
						const providers = providersWithStoredAccounts(ctx, auth);
						if (providers.length === 0) {
							say(ctx, "No stored OAuth accounts. Use /login to add one.");
							return;
						}
						const allLines: string[] = [];
						for (const p of providers) {
							if (allLines.length > 0) allLines.push("");
							allLines.push(...(await formatProviderList(ctx, p)));
						}
						say(ctx, allLines.join("\n"));
						return;
					}

					if (query) {
						say(ctx, (await formatProviderList(ctx, query)).join("\n"));
						return;
					}

					const currentProvider = ctx.model?.provider;
					if (!currentProvider) {
						say(ctx, "No model selected and no provider given. Use /accounts list <provider|all>.", "warning");
						return;
					}

					const loggedIn = providersWithStoredAccounts(ctx, auth);
					if (loggedIn.length === 0) {
						const source = auth.describeCredentialSource?.(currentProvider, ctx.sessionManager.getSessionId());
						say(
							ctx,
							source
								? `No stored OAuth accounts for ${currentProvider}. Current auth comes from ${source}.`
								: `No stored OAuth accounts. Use /login to add one.`,
						);
						return;
					}

					const lines: string[] = [];
					if (loggedIn.includes(currentProvider)) {
						lines.push(...(await formatProviderList(ctx, currentProvider)));
					} else {
						const source = auth.describeCredentialSource?.(currentProvider, ctx.sessionManager.getSessionId());
						lines.push(
							source
								? `No stored OAuth accounts for ${currentProvider}. Current auth comes from ${source}.`
								: `No stored OAuth accounts for ${currentProvider}. Use /login to add one.`,
						);
					}

					const others = loggedIn.filter(p => p !== currentProvider);
					if (others.length > 0) {
						lines.push("", "Other providers with stored accounts (use /accounts list all to expand):");
						const sessionId = ctx.sessionManager.getSessionId();
						for (const p of others) {
							const count = auth.listOAuthAccounts(p, sessionId).length;
							lines.push(`- ${p}: ${count} stored account${count === 1 ? "" : "s"}`);
						}
					}
					say(ctx, lines.join("\n"));
					return;
			}
			case "set": {
					const provider = ctx.model?.provider;
					if (!provider) {
						say(ctx, "Select a model before pinning a provider account.", "warning");
						return;
					}
					if (!ctx.isIdle()) {
						say(ctx, "Cannot pin an account while the session is streaming.", "warning");
						return;
					}
					const auth = authOf(ctx);
					const sessionId = ctx.sessionManager.getSessionId();
					const accounts = auth.listOAuthAccounts(provider, sessionId);
					if (accounts.length === 0) {
						say(ctx, `No stored OAuth accounts for ${provider}. Use /login to add one.`, "warning");
						return;
					}
					let account: OAuthAccountSummary | undefined;
					if (restArgs.trim()) {
						const resolved = resolveAccount(accounts, restArgs);
						if (!resolved.account) {
							say(ctx, resolved.error ?? "No match.", "warning");
							return;
						}
						account = resolved.account;
					} else if (ctx.hasUI) {
						const usage = await usageByCredential(ctx, provider);
						const picked = await ctx.ui.select(
							`Pin which ${provider} account to this session?`,
							accounts.map(a => ({
								label: `${a.position + 1}. ${accountLabel(a)}`,
								description: `${a.active ? "active" : "inactive"}${describeUsage(usage?.get(a.credentialId))}`,
							})),
						);
						if (!picked) return;
						account = accounts[Number.parseInt(picked, 10) - 1];
						if (!account) return;
					} else {
						say(ctx, "Usage: /accounts set <number|email|account id>", "warning");
						return;
					}
					if (!auth.pinSessionOAuthAccount(provider, sessionId, account.credentialId)) {
						say(ctx, `${accountLabel(account)} is no longer available to pin.`, "error");
						return;
					}
					const key = account.email ?? account.accountId;
					if (key) {
						const mapKey = `${sessionId}:${provider}`;
						selfPinnedBySession.set(mapKey, key);
						lastActiveBySession.set(mapKey, key);
					}
					refreshCompletionCache(ctx);
					say(ctx, `Pinned ${accountLabel(account)} to this session for ${provider}.`);
					return;
				}

				case "unset":
				case "auto": {
					const provider = ctx.model?.provider;
					if (!provider) {
						say(ctx, "Select a model first.", "warning");
						return;
					}
					const released = authOf(ctx).releaseSessionCredentialForReselection(
						provider,
						ctx.sessionManager.getSessionId(),
					);
					say(
						ctx,
						released
							? `Released the pinned ${provider} account; built-in omp rotation is back in charge.`
							: `No ${provider} account was pinned for this session.`,
					);
					return;
				}

				case "rotation": {
					const mode = restArgs.trim().toLowerCase();
					if (mode === "status" || mode === "") {
						const provider = ctx.model?.provider;
						const identity = provider
							? authOf(ctx).getOAuthAccountIdentity(provider, ctx.sessionManager.getSessionId())
							: undefined;
						say(ctx, rotationStatusText(config, identity));
						return;
					}
					const parsed = parseRotationMode(mode);
					if (parsed.error) {
						say(ctx, parsed.error, "warning");
						return;
					}
					if (!parsed.policy) return;
					if (parsed.deprecated) say(ctx, parsed.deprecated, "warning");
					config.rotationPolicy = parsed.policy;
					try {
						saveConfig(config);
					} catch (error) {
						say(
							ctx,
							`Failed to persist ${CONFIG_PATH}: ${error instanceof Error ? error.message : error}`,
							"error",
						);
						return;
					}
					const provider = ctx.model?.provider;
					if (config.rotationPolicy === "default") {
						if (provider) {
							authOf(ctx).releaseSessionCredentialForReselection(provider, ctx.sessionManager.getSessionId());
						}
						say(ctx, "Rotation: default (built-in omp). Released any pin.");
						return;
					}
					if (!provider) {
						say(ctx, "Rotation: smart (max remaining quota). Will apply on the next turn once a model is selected.");
						return;
					}
					if (!ctx.isIdle()) {
						say(ctx, "Rotation: smart. Will apply starting with the next turn.");
						return;
					}
					await applyRotation(ctx, provider, "enabled");
					say(ctx, "Rotation: smart (max remaining quota). Each turn pins the account with the most remaining quota.");
					return;
				}

				case "login": {
					const target = restArgs.trim();
					// The Extension API has no programmatic OAuth-login entry point; the flow
					// is TUI-only (built-in /login opens the provider selector). Pre-fill the
					// editor so the user just presses Enter.
					if (ctx.hasUI) {
						ctx.ui.setEditorText(target ? `/login ${target}` : "/login");
						say(ctx, `Press Enter to start the OAuth login flow${target ? ` for ${target}` : ""}.`);
					} else {
						say(
							ctx,
							`Extensions cannot start OAuth login headlessly. Run omp interactively and use /login${target ? ` ${target}` : ""}.`,
							"warning",
						);
					}
					return;
				}

				case "logout": {
					const provider = ctx.model?.provider;
					if (!provider) {
						say(ctx, "Select a model first (or log out via the built-in /logout).", "warning");
						return;
					}
					const auth = authOf(ctx);
					const sessionId = ctx.sessionManager.getSessionId();
					const accounts = auth.listOAuthAccounts(provider, sessionId);
					if (accounts.length === 0) {
						say(ctx, `No stored OAuth accounts for ${provider}.`, "warning");
						return;
					}
					let account: OAuthAccountSummary | undefined;
					if (restArgs.trim()) {
						const resolved = resolveAccount(accounts, restArgs);
						if (!resolved.account) {
							say(ctx, resolved.error ?? "No match.", "warning");
							return;
						}
						account = resolved.account;
					} else if (ctx.hasUI) {
						const picked = await ctx.ui.select(
							`Remove which ${provider} account?`,
							accounts.map(a => `${a.position + 1}. ${accountLabel(a)}`),
						);
						if (!picked) return;
						account = accounts[Number.parseInt(picked, 10) - 1];
						if (!account) return;
					} else {
						say(ctx, "Usage: /accounts logout <number|email|account id>", "warning");
						return;
					}
					if (ctx.hasUI) {
						const confirmed = await ctx.ui.confirm(
							"Remove OAuth account",
							`Remove ${accountLabel(account)} from ${provider}? This cannot be undone (you can /login again).`,
						);
						if (!confirmed) return;
					}
					if (account.active) {
						auth.releaseSessionCredentialForReselection(provider, sessionId);
					}
					const removed = await auth.removeCredential(provider, account.credentialId);
					refreshCompletionCache(ctx);
					say(
						ctx,
						removed
							? `Removed ${accountLabel(account)} from ${provider}.`
							: `Failed to remove ${accountLabel(account)}.`,
						removed ? "info" : "error",
					);
					return;
				}

				case "ceiling": {
					const [action, ...ceilingRest] = rest;
					if (!action) {
						await showCeilingStatus(ctx);
						return;
					}
					if (action === "set") {
						const [modelKey, percentStr, ...fallbackParts] = ceilingRest;
						if (!modelKey || !percentStr) {
							say(
								ctx,
								"Usage: /accounts ceiling set <model> <percent> [fallback]\nExample: /accounts ceiling set claude-opus-4-6 90 anthropic/claude-sonnet-4-6",
								"warning",
							);
							return;
						}
						const percent = Number.parseFloat(percentStr);
						if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
							say(ctx, "Percent must be a number between 1 and 100 (quota used before switching).", "warning");
							return;
						}
						const fallback = fallbackParts.join(" ").trim() || undefined;
						config.models[modelKey] = { maxUsedFraction: percent / 100, fallback };
						try {
							saveConfig(config);
						} catch (error) {
							say(
								ctx,
								`Failed to persist ${CONFIG_PATH}: ${error instanceof Error ? error.message : error}`,
								"error",
							);
							return;
						}
						say(
							ctx,
							`Ceiling set: ${modelKey} switches at > ${percent}% used${fallback ? ` → ${fallback}` : " (no fallback model — add one to enable auto-switch)"}.`,
						);
						return;
					}
					if (action === "unset") {
						const modelKey = ceilingRest.join(" ").trim();
						if (!modelKey) {
							say(ctx, "Usage: /accounts ceiling unset <model>", "warning");
							return;
						}
						if (!config.models[modelKey]) {
							say(ctx, `No ceiling configured for ${modelKey}.`, "warning");
							return;
						}
						delete config.models[modelKey];
						try {
							saveConfig(config);
						} catch (error) {
							say(
								ctx,
								`Failed to persist ${CONFIG_PATH}: ${error instanceof Error ? error.message : error}`,
								"error",
							);
							return;
						}
						say(ctx, `Ceiling removed for ${modelKey}.`);
						return;
					}
					say(ctx, `Unknown ceiling action "${action}". Use set, unset, or bare /accounts ceiling.`, "warning");
					return;
				}

				case "help":
					say(ctx, HELP_TEXT);
					return;

				default:
					say(ctx, `Unknown subcommand "${sub}".\n${HELP_TEXT}`, "warning");
			}
		},
	});
}
