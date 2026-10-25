/**
 * Standalone verification script for AI provider live connection (NVIDIA API / Nebius)
 * Usage:
 *   npx tsx scripts/test-nebius-live.ts
 */

import fs from "node:fs";
import path from "node:path";
import {
  getAIConfig,
  checkNebiusStatus,
  generateChangeProposal,
} from "../src/server/nebiusService";

// Load .env.local if running in standalone script context without Next.js
const envLocalPath = path.resolve(process.cwd(), ".env.local");
if (fs.existsSync(envLocalPath)) {
  const content = fs.readFileSync(envLocalPath, "utf-8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (match) {
      const key = match[1];
      let val = match[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

async function main() {
  const config = getAIConfig();
  const providerTitle = config.provider === "nvidia" ? "NVIDIA API" : "Nebius Token Factory";

  console.log("=================================================");
  console.log(`  Rewind — ${providerTitle} Live Verification    `);
  console.log("=================================================");
  console.log(`Provider: ${config.provider}`);
  console.log(`Base URL: ${config.baseUrl}`);
  console.log(`Model ID: ${config.model}`);
  console.log(`API Key:  ${config.apiKey ? "[CONFIGURED]" : "[UNSET]"}`);
  console.log("-------------------------------------------------");

  if (!config.apiKey) {
    console.log("Status: UNCONFIGURED");
    console.log("");
    console.log(`Configure ${config.keyName} in .env.local to enable live proposals.`);
    return;
  }

  console.log("1. Checking connection & models endpoint...");
  const status = await checkNebiusStatus();
  console.log(`   Connection State:     ${status.state.toUpperCase()}`);
  console.log(`   Endpoint Reachable:   ${status.endpointReachable ? "YES" : "NO"}`);
  console.log(`   Credentials Accepted: ${status.credentialsAccepted ? "YES" : "NO"}`);
  console.log(`   Model in Catalog:     ${status.modelListed ? "YES" : "NO"}`);
  console.log(`   Message:              ${status.message}`);

  if (status.availableModels && status.availableModels.length > 0) {
    console.log(`   Available Models (first ${status.availableModels.length}):`);
    status.availableModels.forEach((m) => console.log(`     - ${m}`));
  }

  if (status.state !== "connected") {
    console.error(`\n[FAILED] Could not establish working connection with ${providerTitle}. Check credentials or model.`);
    process.exit(1);
  }

  console.log(`\n2. Testing live proposal generation with ${config.model}...`);
  const sampleFiles = [
    {
      path: "agent-workflow.json",
      content: JSON.stringify(
        {
          agentName: "NebiusNvidiaRecoveryBot",
          version: "1.0.0",
          permittedTools: ["code_analysis", "diff_verifier"],
          steps: [{ stepId: "01_analyze", action: "code_analysis" }],
        },
        null,
        2
      ),
    },
  ];

  const start = Date.now();
  const proposal = await generateChangeProposal(
    "Update agent-workflow.json to bump version to 1.1.0 and add recovery_guard to permittedTools",
    sampleFiles
  );
  const elapsed = Date.now() - start;

  console.log(`   Proposal ID:     ${proposal.id}`);
  console.log(`   Model Used:      ${proposal.model}`);
  console.log(`   Summary:         ${proposal.summary}`);
  console.log(`   Reasoning:       ${proposal.reasoning}`);
  console.log(`   Expected Result: ${proposal.expectedValidationResult}`);
  console.log(`   Duration:        ${elapsed}ms`);
  console.log(`   Modifications:   ${proposal.modifications.length} file(s)`);
  proposal.modifications.forEach((m) => {
    console.log(`     - ${m.operation.toUpperCase()} ${m.path} (${m.replacementContent.length} bytes)`);
  });

  console.log(`\n[SUCCESS] Live ${providerTitle} proposal generation verified successfully!`);
}

main().catch((err) => {
  console.error("\n[ERROR]", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
