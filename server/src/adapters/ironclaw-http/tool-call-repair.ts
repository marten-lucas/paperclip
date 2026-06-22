/**
 * Tool Call Repair Module
 * 
 * OpenClaw Pattern: 2-tier fallback for tool call extraction
 * Tier 1: Structured JSON parse
 * Tier 2: Plain-text extraction (<tool_call>...</tool_call> tags)
 * Tier 3: Diagnostic + recovery attempt
 */

import { extractJsonFromText } from "./validation.js";

export type ToolCallRepairDiagnostic = {
  tier: 1 | 2 | 3;
  strategy: string;
  success: boolean;
  extracted?: unknown;
  error?: string;
};

/**
 * Extract plain-text tool calls from structured content
 * Looks for patterns like:
 * - <tool_call>...</tool_call>
 * - <call>...</call>
 * - Tool use: ...
 */
export function extractPlainTextToolCalls(text: string): unknown[] {
  const toolCalls: unknown[] = [];

  // Pattern 1: XML-style tags
  const xmlPattern = /<(?:tool_call|call)(?:\s[^>]*)?>([^<]+)<\/(?:tool_call|call)>/g;
  let match;
  while ((match = xmlPattern.exec(text)) !== null) {
    const content = match[1];
    const extracted = extractJsonFromText(content);
    if (extracted) {
      toolCalls.push(extracted);
    }
  }

  // Pattern 2: Markdown code blocks with tool calls
  const codeBlockPattern = /```(?:json|javascript)?\s*([\s\S]*?)```/g;
  while ((match = codeBlockPattern.exec(text)) !== null) {
    const content = match[1];
    if (content.includes("tool") || content.includes("function")) {
      const extracted = extractJsonFromText(content);
      if (extracted && typeof extracted === "object") {
        toolCalls.push(extracted);
      }
    }
  }

  return toolCalls;
}

/**
 * Attempt to recover completion from malformed response
 * Returns diagnostic of what was attempted
 */
export function attemptCompletionRecovery(responseText: string): {
  recovered?: unknown;
  diagnostic: ToolCallRepairDiagnostic;
} {
  // Tier 1: Try direct JSON extraction
  const directJson = extractJsonFromText(responseText);
  if (directJson && typeof directJson === "object") {
    return {
      recovered: directJson,
      diagnostic: {
        tier: 1,
        strategy: "direct-json-extraction",
        success: true,
        extracted: directJson,
      },
    };
  }

  // Tier 2: Try plain-text tool call extraction
  const plainTextCalls = extractPlainTextToolCalls(responseText);
  if (plainTextCalls.length > 0) {
    // Return first successful extraction
    return {
      recovered: plainTextCalls[0],
      diagnostic: {
        tier: 2,
        strategy: "plain-text-extraction",
        success: true,
        extracted: plainTextCalls[0],
      },
    };
  }

  // Tier 3: Diagnostic only
  return {
    diagnostic: {
      tier: 3,
      strategy: "no-recovery-possible",
      success: false,
      error: "Could not extract valid JSON from response using direct extraction or plain-text patterns",
    },
  };
}

/**
 * Format diagnostic for logging
 */
export function formatRecoveryDiagnostic(diag: ToolCallRepairDiagnostic): string {
  const lines: string[] = [
    `[tool-call-repair][tier-${diag.tier}]`,
    `  strategy: ${diag.strategy}`,
    `  success: ${diag.success}`,
  ];

  if (diag.error) {
    lines.push(`  error: ${diag.error}`);
  }

  if (diag.extracted) {
    lines.push(`  extracted: ${JSON.stringify(diag.extracted)}`);
  }

  return lines.join("\n");
}
