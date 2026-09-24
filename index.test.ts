import { describe, expect, test } from "bun:test";
import {
	accountLabel,
	decideRotation,
	normalizeRotationPolicy,
	parseModelFallbackCommand,
	mergeModelFallbackRule,
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
