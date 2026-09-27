import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { expandEntries } from "../archive";

const elmt = (n: string) => strToU8(`<definition type="element"><uuid uuid="{00000000-0000-0000-0000-00000000000${n}}"/></definition>`);

describe("import archive limits", () => {
  it("expands a zip and one nested zip, skipping junk", () => {
    const inner = zipSync({ "b.elmt": elmt("2") });
    const z = zipSync({ "a.elmt": elmt("1"), "inner.zip": inner, "readme.txt": strToU8("x"), "__MACOSX/a.elmt": elmt("3") });
    const r = expandEntries([{ path: "lib.zip", data: z }]);
    expect(r.entries.map((e) => e.path).sort()).toEqual(["a.elmt", "b.elmt"]);
  });

  it("stops a zip bomb before inflating it", () => {
    const big = new Uint8Array(6 * 1024 * 1024); // compresses to a few KB
    const z = zipSync({ "huge.elmt": big }, { level: 9 });
    expect(z.length).toBeLessThan(100_000);
    const r = expandEntries([{ path: "bomb.zip", data: z }]);
    expect(r.entries).toEqual([]);
    expect(r.errors.join()).toMatch(/larger than/);
  });

  it("caps the total unpacked size", () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 45; i++) files[`f${i}.elmt`] = new Uint8Array(4.9 * 1024 * 1024);
    const r = expandEntries([{ path: "many.zip", data: zipSync(files, { level: 9 }) }]);
    expect(r.errors.join()).toMatch(/unpacks to more than/);
  });
});
