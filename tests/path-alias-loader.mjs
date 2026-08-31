import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const relativePath = specifier.slice(2);
    const extension = relativePath.includes(".") ? "" : ".ts";
    return nextResolve(
      pathToFileURL(`${repositoryRoot}${relativePath}${extension}`).href,
      context,
    );
  }

  return nextResolve(specifier, context);
}
