import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// Production regression: Vercel Blob started answering 403 (quota exhausted) and every page that
// reads the demo store returned 500. A Blob failure must degrade to the local deterministic tenant.
const calls = { list: 0, put: 0 };
vi.mock("@vercel/blob", () => {
  const forbidden = () => Promise.reject(new Error("Vercel Blob: Failed to fetch blob: 403 Forbidden"));
  return {
    list: () => (calls.list++, forbidden()),
    get: forbidden,
    put: () => (calls.put++, forbidden()),
  };
});

process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_test_test";
process.env.ORBIS_BLOB_SYNC = "1";
process.env.ORBIS_DATA_DIR = path.join(os.tmpdir(), `orbis-blob-outage-${process.pid}`);

afterAll(() => {
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.ORBIS_BLOB_SYNC;
});

describe("Blob outage", () => {
  it("serves the local tenant instead of throwing, and stops calling Blob", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { getDb, resetDb } = await import("../store");
    const db = await getDb();
    expect(db.actions.length).toBeGreaterThan(0);
    expect(errors).toHaveBeenCalledTimes(1);

    const before = { ...calls };
    await getDb();
    await getDb();
    await resetDb();
    expect(calls).toEqual(before); // breaker open: no further Blob traffic during the cooldown
    errors.mockRestore();
  });

  it("never touches Blob unless ORBIS_BLOB_SYNC=1, even with a token present", async () => {
    const { syncConfigured } = await import("../sync");
    delete process.env.ORBIS_BLOB_SYNC;
    expect(syncConfigured()).toBe(false);
    process.env.ORBIS_BLOB_SYNC = "1";
  });
});
