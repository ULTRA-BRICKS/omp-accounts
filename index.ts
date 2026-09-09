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

interface OAuthAccountSummary {
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
	): { accountId?: string; email?: string; projectId?: string } | undefined;
	getModelUsageHealth(
		provider: string,
		options: { modelId?: string; sessionId?: string; baseUrl?: string; reserveFraction: number },
	): Promise<ModelUsageHealth>;
	removeCredential(provider: string, credentialId: number): Promise<boolean>;
	describeCredentialSource?(provider: string, sessionId?: string): string | undefined;
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

interface AccountsConfig {
	/** Max-remaining-quota rotation policy toggle. */
	rotation: boolean;
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

function loadConfig(): AccountsConfig {
	const fallback: AccountsConfig = { rotation: false, reserveFraction: 0.1, rotationMargin: 0.1, models: {} };
	if (!existsSync(CONFIG_PATH)) return fallback;
	try {
		const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;
		const models: Record<string, ModelCeilingRule> = {};
		if (raw.models && typeof raw.models === "object") {
			for (const [key, value] of Object.entries(raw.models as Record<string, unknown>)) {
				if (typeof value === "number" && Number.isFinite(value)) {
					models[key] = { maxUsedFraction: value };
					continue;
				}
				if (value && typeof value === "object") {
					const obj = value as Record<string, unknown>;
					models[key] = {
						maxUsedFraction:
							typeof obj.maxUsedFraction === "number" && Number.isFinite(obj.maxUsedFraction)
								? obj.maxUsedFraction
								: 0.9,
						fallback:
							typeof obj.fallback === "string" && obj.fallback.trim() ? obj.fallback.trim() : undefined,
					};
				}
			}
		}
		return {
			rotation: raw.rotation === true,
			reserveFraction:
				typeof raw.reserveFraction === "number" && raw.reserveFraction >= 0 && raw.reserveFraction < 1
					? raw.reserveFraction
					: 0.1,
			rotationMargin:
				typeof raw.rotationMargin === "number" && raw.rotationMargin >= 0 && raw.rotationMargin < 1
					? raw.rotationMargin
					: 0.1,
			models,
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

function accountLabel(account: OAuthAccountSummary): string {
	const base = account.email ?? account.accountId ?? `credential ${account.credentialId}`;
	// Default org names are just "<email>'s Organization" — redundant with the label.
	const org = account.orgName;
	return org && org !== `${account.email}'s Organization` ? `${base} (${org})` : base;
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

const HELP_TEXT = [
	"/accounts list [provider] — list OAuth accounts (default: current provider)",
	"/accounts set <n|email|accountId> — pin an account to this session",
	"/accounts unset|auto — release the pin, restore native rotation",
	"/accounts rotation on|off|status — pin the account with the most remaining quota each turn",
	"/accounts login [provider] — start the OAuth login flow (pre-fills /login)",
	"/accounts logout [n|email|accountId] — remove a stored OAuth account",
	"/accounts ceiling — show per-model quota ceiling rules",
].join("\n");

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

export default function accountsExtension(pi: ExtensionAPI) {
	pi.setLabel("Accounts");

	/** Last known active-account key per "sessionId:provider", for switch detection. */
	const lastActiveBySession = new Map<string, string>();
	/** Accounts we pinned ourselves: suppresses the external-rotation notification once. */
	const selfPinnedBySession = new Map<string, string>();

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

	// -- events ---------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.model?.provider) rememberIdentity(ctx, ctx.model.provider);
	});

	pi.on("session_switch", async (_event, ctx) => {
		if (ctx.model?.provider) rememberIdentity(ctx, ctx.model.provider);
	});

	pi.on("turn_start", async (_event, ctx) => {
		const provider = ctx.model?.provider;
		if (!provider) return;
		detectAccountSwitch(ctx, provider);
		if (config.rotation) await applyRotation(ctx, provider, "turn_start");
		await applyCeiling(ctx);
	});

	pi.on("credential_disabled", async (event, ctx) => {
		say(ctx, `Credential disabled for ${event.provider}: ${event.disabledCause}`, "warning");
	});

	// -- /accounts command ----------------------------------------------------

	pi.registerCommand("accounts", {
		description: "Manage OAuth accounts: list, pin, rotation policy, quota ceilings",
		handler: async (args, ctx) => {
			const [sub = "list", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const restArgs = rest.join(" ");

			switch (sub) {
				case "list": {
					const provider = restArgs || ctx.model?.provider;
					if (!provider) {
						say(ctx, "No model selected and no provider given. Use /accounts list <provider>.", "warning");
						return;
					}
					const auth = authOf(ctx);
					const sessionId = ctx.sessionManager.getSessionId();
					const accounts = auth.listOAuthAccounts(provider, sessionId);
					if (accounts.length === 0) {
						const source = auth.describeCredentialSource?.(provider, sessionId);
						say(
							ctx,
							source
								? `No stored OAuth accounts for ${provider}. Current auth comes from ${source}.`
								: `No stored OAuth accounts for ${provider}. Use /login to add one.`,
						);
						return;
					}
					const usage = await usageByCredential(ctx, provider);
					const lines = [`OAuth accounts for ${provider}:`];
					for (const account of accounts) {
						lines.push(
							`${account.position + 1}. ${accountLabel(account)}${account.active ? " (active)" : ""}${describeUsage(usage?.get(account.credentialId))}`,
						);
					}
					lines.push("", "Pin one with /accounts set <number|email|account id>.");
					say(ctx, lines.join("\n"));
					return;
				}

				case "set": {
					if (!restArgs.trim()) {
						say(ctx, "Usage: /accounts set <number|email|account id>", "warning");
						return;
					}
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
					const { account, error } = resolveAccount(accounts, restArgs);
					if (!account) {
						say(ctx, error ?? "No match.", "warning");
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
							? `Released the pinned ${provider} account; native usage-aware rotation is back in charge.`
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
						say(
							ctx,
							[
								`Rotation (max remaining quota): ${config.rotation ? "ON" : "OFF"}`,
								`Hysteresis margin: ${formatPercent(config.rotationMargin)} (depleted active account always rotates)`,
								`Active account: ${identity ? (identity.email ?? identity.accountId ?? "unknown") : "none resolved yet"}`,
								`Config: ${CONFIG_PATH}`,
							].join("\n"),
						);
						return;
					}
					if (mode !== "on" && mode !== "off") {
						say(ctx, "Usage: /accounts rotation on|off|status", "warning");
						return;
					}
					config.rotation = mode === "on";
					try {
						writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
					} catch (error) {
						say(
							ctx,
							`Failed to persist ${CONFIG_PATH}: ${error instanceof Error ? error.message : error}`,
							"error",
						);
						return;
					}
					const provider = ctx.model?.provider;
					if (!config.rotation) {
						if (provider) {
							authOf(ctx).releaseSessionCredentialForReselection(provider, ctx.sessionManager.getSessionId());
						}
						say(ctx, "Rotation OFF. Released any pin; native usage-aware rotation applies.");
						return;
					}
					if (!provider) {
						say(ctx, "Rotation ON. It will apply on the next turn once a model is selected.");
						return;
					}
					if (!ctx.isIdle()) {
						say(ctx, "Rotation ON. It will apply starting with the next turn.");
						return;
					}
					await applyRotation(ctx, provider, "enabled");
					say(ctx, "Rotation ON: each turn pins the account with the most remaining quota.");
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
					const entries = Object.entries(config.models);
					if (entries.length === 0) {
						say(
							ctx,
							`No per-model ceilings configured. Add a "models" map to ${CONFIG_PATH}, e.g.\n` +
								`{ "models": { "claude-opus-4-6": { "maxUsedFraction": 0.9, "fallback": "anthropic/claude-sonnet-4-6" } } }\n` +
								"Note: retry.usageReservePct already guards quota globally; ceilings add per-model control.",
						);
						return;
					}
					const lines = ["Per-model quota ceilings:"];
					for (const [model, rule] of entries) {
						lines.push(
							`- ${model}: switch at > ${formatPercent(rule.maxUsedFraction)} used${rule.fallback ? ` → ${rule.fallback}` : ""}`,
						);
					}
					lines.push(
						"",
						`Edit ${CONFIG_PATH} to change; the global retry.usageReservePct reserve still applies on top.`,
					);
					say(ctx, lines.join("\n"));
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
