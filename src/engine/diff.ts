/**
 * Minimal, dependency-free unified diff generator
 */

export function generateUnifiedDiff(
  filePath: string,
  oldContent: string = "",
  newContent: string = ""
): string {
  const oldLines = oldContent.split(/\r?\n/);
  const newLines = newContent.split(/\r?\n/);

  if (oldContent === newContent) {
    return `--- a/${filePath}\n+++ b/${filePath}\n@@ No changes @@`;
  }

  const diffLines: string[] = [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
  ];

  const maxLines = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < maxLines; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];

    if (oldLine === newLine) {
      if (oldLine !== undefined) {
        diffLines.push(`  ${oldLine}`);
      }
    } else {
      if (oldLine !== undefined) {
        diffLines.push(`- ${oldLine}`);
      }
      if (newLine !== undefined) {
        diffLines.push(`+ ${newLine}`);
      }
    }
  }

  return diffLines.join("\n");
}
