import { describe, expect, mock, test } from "bun:test";
import accountsExtension, {
	accountLabel,
	decideRotation,
	normalizeRotationPolicy,
	parseModelFallbackCommand,
	mergeModelFallbackRule,
	formatCommandUsageError,
	type ModelFallbackSetParse,
	parseRotationMode,
	buildSubcommandInlineHint,
	accountsInlineHint,
	type OAuthAccountSummary,
} from "./index.ts";

describe("normalizeRotationPolicy", () => {
	test("fresh install defaults to smart", () => {
		expect(normalizeRotationPolicy({}, false)).toBe("smart");
	});

	test("existing file without policy field defaults to default (legacy off)", () => {
		expect(normalizeRotationPolicy({}, true)).toBe("default");
	});

	test("rotationPolicy smart wins", () => {
		expect(normalizeRotationPolicy({ rotationPolicy: "smart" }, true)).toBe("smart");
	});

	test("rotationPolicy default wins", () => {
		expect(normalizeRotationPolicy({ rotationPolicy: "default" }, true)).toBe("default");
	});

	test("migrates rotation true to smart", () => {
		expect(normalizeRotationPolicy({ rotation: true }, true)).toBe("smart");
	});

	test("migrates rotation false to default", () => {
		expect(normalizeRotationPolicy({ rotation: false }, true)).toBe("default");
	});

	test("rotationPolicy overrides legacy rotation boolean", () => {
		expect(normalizeRotationPolicy({ rotationPolicy: "default", rotation: true }, true)).toBe("default");
	});
});

describe("parseRotationMode", () => {
	test("accepts smart and default", () => {
		expect(parseRotationMode("smart").policy).toBe("smart");
		expect(parseRotationMode("default").policy).toBe("default");
	});

	test("deprecated on maps to smart with warning", () => {
		const parsed = parseRotationMode("on");
		expect(parsed.policy).toBe("smart");
		expect(parsed.deprecated).toContain("smart");
	});

	test("deprecated off maps to default with warning", () => {
		const parsed = parseRotationMode("off");
		expect(parsed.policy).toBe("default");
		expect(parsed.deprecated).toContain("default");
	});
});

describe("accountLabel", () => {
	test("prefers email", () => {
		const account: OAuthAccountSummary = {
			position: 0,
			credentialId: 1,
			email: "alice@example.com",
			active: false,
		};
		expect(accountLabel(account)).toBe("alice@example.com");
	});

	test("adds meaningful org name", () => {
		const account: OAuthAccountSummary = {
			position: 0,
			credentialId: 1,
			email: "alice@example.com",
			orgName: "Example Org",
			active: false,
		};
		expect(accountLabel(account)).toBe("alice@example.com (Example Org)");
	});

	test("skips redundant default org name", () => {
		const account: OAuthAccountSummary = {
			position: 0,
			credentialId: 1,
			email: "alice@example.com",
			orgName: "alice@example.com's Organization",
			active: false,
		};
		expect(accountLabel(account)).toBe("alice@example.com");
	});

	test("falls back to orgName then accountId (kimi-style)", () => {
		expect(
			accountLabel({
				position: 0,
				credentialId: 2,
				accountId: "kimi-user-abc123",
				active: false,
			}),
		).toBe("kimi-user-abc123");
	});
});

describe("decideRotation", () => {
	test("pins when no active account", () => {
		const best = { credentialId: 1, credentialType: "oauth", state: "healthy" as const, remainingFraction: 0.8 };
		expect(decideRotation(undefined, best, 0.1).pin).toBe(true);
	});

	test("stays within margin", () => {
		const active = { credentialId: 1, credentialType: "oauth", state: "healthy" as const, remainingFraction: 0.75 };
		const best = { credentialId: 2, credentialType: "oauth", state: "healthy" as const, remainingFraction: 0.8 };
		expect(decideRotation(active, best, 0.1).pin).toBe(false);
	});
});

describe("parseModelFallbackCommand", () => {
	test("bare tokens return status", () => {
		expect(parseModelFallbackCommand([])).toEqual({ kind: "status" });
	});

	test("status and help verbs", () => {
		expect(parseModelFallbackCommand(["status"])).toEqual({ kind: "status" });
		expect(parseModelFallbackCommand(["help"])).toEqual({ kind: "help" });
	});

	test("set parses model, percent, and optional fallback", () => {
		expect(parseModelFallbackCommand(["set", "claude-opus-4-6", "90", "anthropic/claude-sonnet-4-6"])).toEqual({
			kind: "set",
			modelKey: "claude-opus-4-6",
			percent: 90,
			fallback: "anthropic/claude-sonnet-4-6",
		});
	});

	test("set without fallback", () => {
		expect(parseModelFallbackCommand(["set", "gpt-5", "85"])).toEqual({
			kind: "set",
			modelKey: "gpt-5",
			percent: 85,
			fallback: undefined,
		});
	});

	test("set rejects missing args and invalid percent", () => {
		expect(parseModelFallbackCommand(["set", "model-only"]).kind).toBe("error");
		expect(parseModelFallbackCommand(["set", "m", "0"]).kind).toBe("error");
		expect(parseModelFallbackCommand(["set", "m", "101"]).kind).toBe("error");
	});

	test("set rejects a percent with trailing garbage instead of silently truncating it", () => {
		expect(parseModelFallbackCommand(["set", "m", "90abc"]).kind).toBe("error");
		expect(parseModelFallbackCommand(["set", "m", "90%"]).kind).toBe("error");
		expect(parseModelFallbackCommand(["set", "m", "90,"]).kind).toBe("error");
	});

	test("unset requires model key", () => {
		expect(parseModelFallbackCommand(["unset", "claude-opus-4-6"])).toEqual({
			kind: "unset",
			modelKey: "claude-opus-4-6",
		});
		expect(parseModelFallbackCommand(["unset"]).kind).toBe("error");
	});

	test("unknown action is error", () => {
		expect(parseModelFallbackCommand(["nope"]).kind).toBe("error");
	});
});

/** Parses a `set` command and narrows to the `set` variant, failing loudly if parsing didn't produce one. */
function parseSet(...tokens: string[]): ModelFallbackSetParse {
	const parsed = parseModelFallbackCommand(["set", ...tokens]);
	if (parsed.kind !== "set") throw new Error("test setup failed");
	return parsed;
}

/** Parses a command and returns its error message, failing loudly if parsing didn't produce an error. */
function parseError(...tokens: string[]): string {
	const parsed = parseModelFallbackCommand(tokens);
	if (parsed.kind !== "error") throw new Error("test setup failed");
	return parsed.message;
}

describe("mergeModelFallbackRule", () => {
	test("a bare set with no fallback token keeps a previously configured fallback", () => {
		const existing = { maxUsedFraction: 0.9, fallback: "anthropic/claude-sonnet-4-6" };
		expect(mergeModelFallbackRule(existing, parseSet("claude-opus-4-6", "95"))).toEqual({
			maxUsedFraction: 0.95,
			fallback: "anthropic/claude-sonnet-4-6",
		});
	});

	test("supplying a new fallback token replaces the previous one", () => {
		const existing = { maxUsedFraction: 0.9, fallback: "anthropic/claude-sonnet-4-6" };
		expect(mergeModelFallbackRule(existing, parseSet("claude-opus-4-6", "95", "gpt-5"))).toEqual({
			maxUsedFraction: 0.95,
			fallback: "gpt-5",
		});
	});

	test("first set for a model with no fallback token has no fallback", () => {
		expect(mergeModelFallbackRule(undefined, parseSet("claude-opus-4-6", "90"))).toEqual({
			maxUsedFraction: 0.9,
			fallback: undefined,
		});
	});
});

describe("formatCommandUsageError", () => {
	test("prefixes both the Usage and Example lines with the invoking command path", () => {
		expect(formatCommandUsageError(parseError("set", "opus"), "/model-fallback")).toBe(
			"Usage: /model-fallback set <model> <percent> [fallback]\nExample: /model-fallback set claude-opus-4-6 90 anthropic/claude-sonnet-4-6",
		);
	});

	test("uses the /accounts ceiling command path when called from that alias", () => {
		expect(formatCommandUsageError(parseError("set", "opus"), "/accounts ceiling")).toBe(
			"Usage: /accounts ceiling set <model> <percent> [fallback]\nExample: /accounts ceiling set claude-opus-4-6 90 anthropic/claude-sonnet-4-6",
		);
	});

	test("a single-line message (no Example line) is still prefixed", () => {
		expect(formatCommandUsageError(parseError("unset"), "/model-fallback")).toBe(
			"Usage: /model-fallback unset <model>",
		);
	});

	test("a $-containing commandPath is inserted literally, not reinterpreted as a replacement pattern", () => {
		expect(formatCommandUsageError("Usage: unset <model>", "$&")).toBe("Usage: $& unset <model>");
	});

	test("passes through the percent-validation error unchanged (no Usage/Example line to prefix)", () => {
		const message = parseError("set", "m", "0");
		expect(formatCommandUsageError(message, "/model-fallback")).toBe(message);
	});

	test("passes through the unknown-action error unchanged ('Use set, ...' does not start with 'Usage: ')", () => {
		const message = parseError("nope");
		expect(formatCommandUsageError(message, "/model-fallback")).toBe(message);
	});
});

describe("inline hints", () => {
	const modelHint = buildSubcommandInlineHint([
		{ name: "set", description: "set", usage: "<model> <percent> [fallback]" },
		{ name: "unset", description: "unset", usage: "<model>" },
	]);
	test("model-fallback set ghost text", () => {
		expect(modelHint("se")).toBe("t <model> <percent> [fallback]");
	});
	test("accounts ceiling delegates to model-fallback hints", () => {
		expect(accountsInlineHint("ceiling se")).toBe("t <model> <percent> [fallback]");
		expect(accountsInlineHint("li")).toBe("st [provider|all]");
	});
});

// -----------------------------------------------------------------------------
// Regression test for the "authOf(ctx).getOAuthAccountIdentity is not a
// function" class of bug: AuthStorageLike drifting from the real namespaced
// AuthStorage facade (.oauth/.sessions/.health/.credentials/.keys). Exercises
// every AuthStorageLike method through the actual registered hooks and the
// /accounts command handler against a mock shaped exactly like the real
// facade, so a future rename/move of any method fails loudly here instead of
// at runtime in a user's session.
// -----------------------------------------------------------------------------
describe("accountsExtension against the namespaced AuthStorage facade", () => {
	/** Minimal structural shape this test needs from ExtensionContext/ExtensionCommandContext. */
	interface TestCtx {
		sessionManager: { getSessionId(): string };
		modelRegistry: { authStorage: unknown };
		model: { provider: string; id: string; baseUrl: string | undefined };
		models: { list(): Array<{ provider: string; id: string }> };
		hasUI: boolean;
		isIdle(): boolean;
	}

	/** Minimal structural shape this test needs from ExtensionAPI. */
	interface TestPi {
		setLabel(label: string): void;
		on(name: string, fn: (event: unknown, ctx: TestCtx) => unknown): void;
		registerCommand(name: string, def: { handler: (args: string, ctx: TestCtx) => unknown }): void;
	}

	// A model id that cannot collide with a real developer's accounts.config.json
	// ceiling rules: loadConfig() reads that file eagerly at module import time
	// (no test seam), so `turn_start` -> applyCeiling must be a guaranteed no-op
	// regardless of the machine's real config content.
	const TEST_MODEL_ID = "test-model-no-ceiling-rule-can-match-this-9c1f3a";

	function buildHarness() {
		const hooks: Record<string, (event: unknown, ctx: TestCtx) => unknown> = {};
		const commands: Record<string, { handler: (args: string, ctx: TestCtx) => unknown }> = {};
		const pi: TestPi = {
			setLabel: () => {},
			on: (name, fn) => {
				hooks[name] = fn;
			},
			registerCommand: (name, def) => {
				commands[name] = def;
			},
		};
		// TestPi models only the ExtensionAPI surface this extension calls; the real
		// type comes from an external package this repo doesn't depend on for types.
		accountsExtension(pi as unknown as Parameters<typeof accountsExtension>[0]);

		// Only "anthropic" has stored accounts; any other provider is empty, which
		// exercises the keys.describe fallback branch below.
		const accounts: OAuthAccountSummary[] = [
			{ position: 0, credentialId: 1, email: "a@example.com", accountId: "acc1", active: true },
			{ position: 1, credentialId: 2, email: "b@example.com", accountId: "acc2", active: false },
		];
		const authStorage = {
			oauth: {
				accounts: mock((provider: string) => (provider === "anthropic" ? accounts : [])),
				identity: mock(() => ({ email: "a@example.com", accountId: "acc1" })),
			},
			sessions: {
				pin: mock(() => true),
				release: mock(() => true),
			},
			health: {
				model: mock(async () => ({
					state: "healthy" as const,
					accounts: [
						{ credentialId: 1, credentialType: "oauth", state: "healthy" as const, remainingFraction: 0.8 },
						{ credentialId: 2, credentialType: "oauth", state: "healthy" as const, remainingFraction: 0.5 },
					],
				})),
			},
			credentials: {
				removeById: mock(async () => true),
				all: mock(() => ({ anthropic: [{}] })),
			},
			keys: {
				describe: mock(() => "stored key"),
			},
		};
		function ctx(): TestCtx {
			return {
				sessionManager: { getSessionId: () => "sess1" },
				modelRegistry: { authStorage },
				model: { provider: "anthropic", id: TEST_MODEL_ID, baseUrl: undefined },
				models: { list: () => [{ provider: "anthropic", id: TEST_MODEL_ID }] },
				hasUI: false,
				isIdle: () => true,
			};
		}
		return { hooks, commands, authStorage, ctx };
	}

	test("session_start and turn_start hooks are registered and resolve through oauth/health", async () => {
		const { hooks, authStorage, ctx } = buildHarness();
		expect(hooks.session_start).toBeDefined();
		expect(hooks.turn_start).toBeDefined();
		await hooks.session_start!({}, ctx());
		await hooks.turn_start!({}, ctx());
		// turn_start always calls oauth.accounts (via refreshCompletionCache) and
		// applyCeiling, which no-ops before ever calling health.model because
		// TEST_MODEL_ID matches no configured ceiling rule.
		expect(authStorage.oauth.accounts).toHaveBeenCalled();
	});

	test("/accounts list calls oauth.accounts; /accounts list <empty provider> falls through to keys.describe", async () => {
		const { commands, authStorage, ctx } = buildHarness();
		expect(commands.accounts).toBeDefined();
		await commands.accounts.handler("list", ctx());
		expect(authStorage.oauth.accounts).toHaveBeenCalledWith("anthropic", "sess1");

		await commands.accounts.handler("list some-other-provider", ctx());
		expect(authStorage.oauth.accounts).toHaveBeenCalledWith("some-other-provider", "sess1");
		expect(authStorage.keys.describe).toHaveBeenCalledWith("some-other-provider", "sess1");
	});

	test("/accounts set pins through sessions.pin", async () => {
		const { commands, authStorage, ctx } = buildHarness();
		await commands.accounts.handler("set 1", ctx());
		expect(authStorage.sessions.pin).toHaveBeenCalledWith("anthropic", "sess1", 1);
	});

	test("/accounts unset releases through sessions.release without touching stored config", async () => {
		const { commands, authStorage, ctx } = buildHarness();
		await commands.accounts.handler("unset", ctx());
		expect(authStorage.sessions.release).toHaveBeenCalledWith("anthropic", "sess1");
	});

	test("/accounts rotation status reads identity through oauth.identity without touching stored config", async () => {
		const { commands, authStorage, ctx } = buildHarness();
		await commands.accounts.handler("rotation status", ctx());
		expect(authStorage.oauth.identity).toHaveBeenCalled();
	});

	test("/accounts logout releases and removes through sessions.release + credentials.removeById", async () => {
		const { commands, authStorage, ctx } = buildHarness();
		await commands.accounts.handler("logout 1", ctx());
		expect(authStorage.sessions.release).toHaveBeenCalledWith("anthropic", "sess1");
		expect(authStorage.credentials.removeById).toHaveBeenCalledWith("anthropic", 1);
	});
});
