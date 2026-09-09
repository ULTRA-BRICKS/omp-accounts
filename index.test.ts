import { describe, expect, test } from "bun:test";
import {
	accountLabel,
	decideRotation,
	normalizeRotationPolicy,
	parseRotationMode,
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
