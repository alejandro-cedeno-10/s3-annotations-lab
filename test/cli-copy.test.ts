import { describe, expect, it } from "vitest";
import { COPY_PROPS_VALUES, copyCommandArgs } from "../src/lab/cli-copy";

describe("copyCommandArgs", () => {
  it("builds an s3 cp command with the copy-props value and the lab region", () => {
    expect(copyCommandArgs({ bucket: "b", sourceKey: "lab/big", targetKey: "lab/big-copy", copyProps: "all" })).toEqual([
      "s3",
      "cp",
      "s3://b/lab/big",
      "s3://b/lab/big-copy",
      "--copy-props",
      "all",
      "--region",
      "us-east-1",
    ]);
  });

  it.each(COPY_PROPS_VALUES)("passes %s through unchanged", (copyProps) => {
    const args = copyCommandArgs({ bucket: "b", sourceKey: "a", targetKey: "c", copyProps });
    expect(args[args.indexOf("--copy-props") + 1]).toBe(copyProps);
  });
});
