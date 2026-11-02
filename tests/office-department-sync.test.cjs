"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("index.js", "utf8");

function extractFunction(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, "Could not find source marker: " + startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, "Could not find end marker: " + endMarker);
  return source.slice(start, end).trim();
}

const syncPlacementSource = extractFunction(
  "async function syncOfficeDepartmentPlacement(",
  "\nasync function listOfficeActiveDepartmentAssignments(",
);
const deactivateSource = extractFunction(
  "async function deactivateOfficeDepartmentPlacement(",
  "\n/**\n * Only sync a placement",
);
const reconcileSource = extractFunction(
  "async function runOfficeDepartmentSync(",
  "\nfunction startOfficeDepartmentSync(",
);

const placement = {
  discordId: "discord-123",
  robloxUserId: "roblox-456",
  robloxUsername: "SweetMember",
  placementType: "team",
  placementKey: "recruitment",
  placementLabel: "Recruitment",
  assignedByDiscordId: "admin-1",
  assignedByTag: "admin#0001",
  updatedAt: new Date("2026-11-02T12:00:00.000Z"),
};

function makeSyncHarness(overrides = {}) {
  const calls = [];
  const deactivations = [];
  const context = {
    Date,
    console: { warn() {}, log() {}, error() {} },
    OFFICE_EMAIL_DOMAIN: "sweetsiez.com",
    getOfficeSupabaseConfig: () => ({ url: "https://example.supabase.co", key: "test-key" }),
    getPlacementConfig: () => ({ boardKey: "operations", label: "Recruitment" }),
    SWEETSIEZ_STRUCTURE_CONFIG: { BOARDS: { operations: {} } },
    VerifiedUser: {
      findOne: () => ({
        lean: async () => ({
          robloxId: "roblox-456",
          robloxUsername: "SweetMember",
          officeEmailLower: "sweetmember@sweetsiez.com",
        }),
      }),
    },
    resolveOfficeIdentityByEmail: async () => ({
      statusCode: 200,
      body: {
        ok: true,
        verificationStatus: "verified",
        robloxUserId: "roblox-456",
        membershipStatus: "in_group",
        discordUserId: "discord-123",
        discordUserIds: ["discord-123"],
        email: "sweetmember@sweetsiez.com",
      },
    }),
    getOfficeProfileIdByEmail: async () => ({ ok: true, profileId: "profile-789" }),
    callOfficeSupabase: async (path, payload) => {
      calls.push({ path, payload });
      return { ok: true };
    },
    deactivateOfficeDepartmentPlacement: async (...args) => {
      deactivations.push(args);
      return { ok: true };
    },
    ...overrides,
  };
  const sync = vm.runInNewContext(syncPlacementSource + "\nsyncOfficeDepartmentPlacement;", context);
  const deactivate = vm.runInNewContext(deactivateSource + "\ndeactivateOfficeDepartmentPlacement;", context);
  return { calls, context, sync, deactivate, deactivations };
}

test("verified, uniquely resolved placement is mirrored with its Office profile", async () => {
  const h = makeSyncHarness();
  const result = await h.sync(placement, "test");

  assert.equal(result.ok, true);
  assert.equal(result.profileLinked, true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].path, "/rest/v1/rpc/office_sync_department_assignment");
  assert.equal(h.calls[0].payload.p_discord_user_id, "discord-123");
  assert.equal(h.calls[0].payload.p_profile_id, "profile-789");
  assert.equal(h.calls[0].payload.p_department_key, "operations");
});

test("ambiguous Discord candidates are mirrored without linking a profile", async () => {
  const h = makeSyncHarness({
    resolveOfficeIdentityByEmail: async () => ({
      statusCode: 200,
      body: {
        ok: true,
        verificationStatus: "verified",
        robloxUserId: "roblox-456",
        membershipStatus: "in_group",
        discordUserId: null,
        discordUserIds: ["discord-123", "discord-999"],
      },
    }),
  });

  const result = await h.sync(placement, "test");

  assert.equal(result.ok, true);
  assert.equal(result.profileLinked, false);
  assert.equal(h.calls[0].payload.p_profile_id, null);
  assert.equal(h.deactivations.length, 0);
});

test("inconclusive identity resolution never deactivates an existing placement", async () => {
  const h = makeSyncHarness({
    resolveOfficeIdentityByEmail: async () => ({
      statusCode: 503,
      body: { ok: false },
    }),
  });

  const result = await h.sync(placement, "test");

  assert.equal(result.ok, false);
  assert.equal(result.reason, "identity_resolver_unavailable");
  assert.equal(h.calls.some(call => call.deactivate), false);
  assert.equal(h.calls.some(call => call.path), false);
});

test("a positively mismatched Roblox identity deactivates the old Discord placement", async () => {
  const h = makeSyncHarness({
    resolveOfficeIdentityByEmail: async () => ({
      statusCode: 200,
      body: {
        ok: true,
        verificationStatus: "verified",
        robloxUserId: "different-roblox-id",
        membershipStatus: "in_group",
      },
    }),
  });

  const result = await h.sync(placement, "test");

  assert.equal(result.reason, "office_identity_verification_mismatch");
  assert.equal(h.deactivations.length, 1);
  assert.equal(h.deactivations[0][0], "discord-123");
  assert.equal(h.deactivations[0][1], "office_identity_verification_mismatch");
});

test("a failed Supabase assignment request is returned as a failure, not thrown", async () => {
  const h = makeSyncHarness({
    callOfficeSupabase: async (path, payload) => {
      hCalls.push({ path, payload });
      return { ok: false, reason: "http_503" };
    },
  });
  const hCalls = h.calls;

  const result = await h.sync(placement, "test");

  assert.equal(result.ok, false);
  assert.equal(result.reason, "http_503");
  assert.equal(h.calls.length, 1);
});

test("department removal calls the deactivation RPC with its reason and source timestamp", async () => {
  const h = makeSyncHarness();
  const timestamp = new Date("2026-11-02T13:00:00.000Z");

  const result = await h.deactivate("discord-123", "removed_by_admin", timestamp);

  assert.equal(result.ok, true);
  assert.equal(h.calls[0].path, "/rest/v1/rpc/office_deactivate_department_assignment");
  assert.equal(h.calls[0].payload.p_discord_user_id, "discord-123");
  assert.equal(h.calls[0].payload.p_inactive_reason, "removed_by_admin");
  assert.equal(h.calls[0].payload.p_source_updated_at, timestamp.toISOString());
});

test("failed Supabase deactivation is surfaced without pretending removal succeeded", async () => {
  const h = makeSyncHarness({
    callOfficeSupabase: async () => ({ ok: false, reason: "request_failed" }),
  });

  const result = await h.deactivate("discord-123", "removed_by_admin", new Date());

  assert.equal(result.ok, false);
  assert.equal(result.reason, "request_failed");
});

function makeReconcileHarness({ mongoRead, officeRows } = {}) {
  const deactivations = [];
  const context = {
    console: { warn() {}, log() {}, error() {} },
    officeDepartmentSyncRunning: false,
    getOfficeSupabaseConfig: () => ({ url: "https://example.supabase.co", key: "test-key" }),
    mongoose: { connection: { readyState: 1 } },
    StaffPlacement: {
      find: () => ({
        lean: mongoRead || (async () => []),
      }),
    },
    syncOfficeDepartmentPlacement: async () => ({ ok: true }),
    listOfficeActiveDepartmentAssignments: async () => officeRows || ({ ok: true, rows: [] }),
    deactivateOfficeDepartmentPlacement: async (...args) => {
      deactivations.push(args);
      return { ok: true };
    },
  };
  const reconcile = vm.runInNewContext(reconcileSource + "\nrunOfficeDepartmentSync;", context);
  return { deactivations, reconcile };
}

test("MongoDB read failure prevents reconciliation from deactivating Office assignments", async () => {
  const h = makeReconcileHarness({
    mongoRead: async () => { throw new Error("MongoDB unavailable"); },
    officeRows: { ok: true, rows: [{ discord_user_id: "discord-123" }] },
  });

  const result = await h.reconcile("test");

  assert.equal(result.reason, "mongodb_read_failed");
  assert.equal(h.deactivations.length, 0);
});

test("an unavailable Office assignment read skips stale-row cleanup", async () => {
  const h = makeReconcileHarness({
    officeRows: { ok: false, reason: "http_503" },
  });

  const result = await h.reconcile("test");

  assert.equal(result.staleCheck, "skipped");
  assert.equal(h.deactivations.length, 0);
});

test("only Discord IDs absent from a successful MongoDB read are deactivated as stale", async () => {
  const h = makeReconcileHarness({
    mongoRead: async () => [
      { discordId: "discord-still-assigned" },
    ],
    officeRows: {
      ok: true,
      rows: [
        { discord_user_id: "discord-still-assigned" },
        { discord_user_id: "discord-no-longer-assigned" },
      ],
    },
  });

  const result = await h.reconcile("test");

  assert.equal(result.deactivated, 1);
  assert.equal(h.deactivations.length, 1);
  assert.equal(h.deactivations[0][0], "discord-no-longer-assigned");
  assert.equal(h.deactivations[0][1], "placement_missing_from_mongodb");
});
