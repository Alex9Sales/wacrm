/**
 * Derive canvas edges from the flow's node list.
 *
 * Edges live INSIDE each node's `config` JSONB (each button row /
 * list row / condition branch carries its own `next_node_key`). The
 * canvas needs them as a separate `{ source, target, label,
 * sourceHandle }` list to render arrows, and the labels need to be
 * meaningful — a `send_buttons` node with three buttons isn't useful
 * on the canvas if the three outgoing arrows are unlabeled.
 *
 * Why this lives in lib/flows (not next to flow-canvas.tsx): the
 * derivation is pure data manipulation with no React-Flow types in
 * it, which makes it (a) trivially unit-testable and (b) reusable by
 * the editable canvas (PR 2) without dragging in client-only deps.
 *
 * `sourceHandle` ids are stable strings the canvas wires up to its
 * per-node renderer's outgoing connection points. They match the
 * scheme PR 2's drag-to-connect handler will read:
 *   - `next`            for single-outgoing nodes
 *   - `button:<reply_id>` for send_buttons rows
 *   - `row:<reply_id>`    for send_list rows
 *   - `true` / `false`    for condition branches
 */

import type { BuilderNode } from "@/components/flows/shared";

export interface CanvasEdge {
  /** Stable per-edge id — required by React-Flow. */
  id: string;
  /** node_key of the source node. */
  source: string;
  /** node_key of the target node. */
  target: string;
  /** Identifies which outgoing slot on the source node this edge belongs to. */
  sourceHandle: string;
  /** Human-readable label rendered on the canvas (e.g. "Yes button"). */
  label?: string;
}

export function deriveCanvasEdges(nodes: BuilderNode[]): CanvasEdge[] {
  const knownKeys = new Set(nodes.map((n) => n.node_key));
  const edges: CanvasEdge[] = [];

  for (const node of nodes) {
    const cfg = node.config;
    switch (node.node_type) {
      case "start":
      case "send_message":
      case "send_media":
      case "collect_input":
      case "set_tag":
      case "action":
      case "delay": {
        const next = (cfg as { next_node_key?: string }).next_node_key;
        if (next && knownKeys.has(next)) {
          edges.push({
            id: `${node.node_key}--next--${next}`,
            source: node.node_key,
            target: next,
            sourceHandle: "next",
          });
        }
        break;
      }

      case "jump": {
        // Jump's edge points at target_node_key (its loop target), not
        // next_node_key. Same "next" handle so the card renders one port.
        const next = (cfg as { target_node_key?: string }).target_node_key;
        if (next && knownKeys.has(next)) {
          edges.push({
            id: `${node.node_key}--next--${next}`,
            source: node.node_key,
            target: next,
            sourceHandle: "next",
          });
        }
        break;
      }

      case "randomizer": {
        const branches = Array.isArray(
          (cfg as { branches?: unknown }).branches,
        )
          ? ((cfg as { branches: Array<Record<string, unknown>> }).branches)
          : [];
        const total = branches.reduce<number>(
          (s, b) =>
            s + (typeof b.weight === "number" ? Math.max(0, b.weight) : 0),
          0,
        );
        for (const br of branches) {
          const id = typeof br.id === "string" ? br.id : null;
          const next =
            typeof br.next_node_key === "string" ? br.next_node_key : null;
          if (!id || !next || !knownKeys.has(next)) continue;
          const w = typeof br.weight === "number" ? Math.max(0, br.weight) : 0;
          const pct = total > 0 ? Math.round((w / total) * 100) : 0;
          edges.push({
            id: `${node.node_key}--branch:${id}--${next}`,
            source: node.node_key,
            target: next,
            sourceHandle: `branch:${id}`,
            label: `${pct}%`,
          });
        }
        break;
      }

      case "http_fetch": {
        const next = (cfg as { next_node_key?: string }).next_node_key;
        const errNext = (cfg as { error_node_key?: string }).error_node_key;
        if (next && knownKeys.has(next)) {
          edges.push({
            id: `${node.node_key}--next--${next}`,
            source: node.node_key,
            target: next,
            sourceHandle: "next",
            label: "ok",
          });
        }
        if (errNext && knownKeys.has(errNext)) {
          edges.push({
            id: `${node.node_key}--error--${errNext}`,
            source: node.node_key,
            target: errNext,
            sourceHandle: "error",
            label: "erro",
          });
        }
        break;
      }

      case "condition": {
        const trueNext = (cfg as { true_next?: string }).true_next;
        const falseNext = (cfg as { false_next?: string }).false_next;
        if (trueNext && knownKeys.has(trueNext)) {
          edges.push({
            id: `${node.node_key}--true--${trueNext}`,
            source: node.node_key,
            target: trueNext,
            sourceHandle: "true",
            label: "true",
          });
        }
        if (falseNext && knownKeys.has(falseNext)) {
          edges.push({
            id: `${node.node_key}--false--${falseNext}`,
            source: node.node_key,
            target: falseNext,
            sourceHandle: "false",
            label: "false",
          });
        }
        break;
      }

      case "send_buttons": {
        const buttons = Array.isArray(
          (cfg as { buttons?: unknown }).buttons,
        )
          ? ((cfg as { buttons: Array<Record<string, unknown>> }).buttons)
          : [];
        for (const btn of buttons) {
          const replyId =
            typeof btn.reply_id === "string" ? btn.reply_id : null;
          const next =
            typeof btn.next_node_key === "string" ? btn.next_node_key : null;
          const title = typeof btn.title === "string" ? btn.title : null;
          if (!replyId || !next || !knownKeys.has(next)) continue;
          edges.push({
            id: `${node.node_key}--button:${replyId}--${next}`,
            source: node.node_key,
            target: next,
            sourceHandle: `button:${replyId}`,
            label: title ?? replyId,
          });
        }
        break;
      }

      case "send_list": {
        const sections = Array.isArray(
          (cfg as { sections?: unknown }).sections,
        )
          ? ((cfg as { sections: Array<Record<string, unknown>> }).sections)
          : [];
        for (const section of sections) {
          const rows = Array.isArray(section.rows)
            ? (section.rows as Array<Record<string, unknown>>)
            : [];
          for (const row of rows) {
            const replyId =
              typeof row.reply_id === "string" ? row.reply_id : null;
            const next =
              typeof row.next_node_key === "string" ? row.next_node_key : null;
            const title = typeof row.title === "string" ? row.title : null;
            if (!replyId || !next || !knownKeys.has(next)) continue;
            edges.push({
              id: `${node.node_key}--row:${replyId}--${next}`,
              source: node.node_key,
              target: next,
              sourceHandle: `row:${replyId}`,
              label: title ?? replyId,
            });
          }
        }
        break;
      }

      case "handoff":
      case "end":
        // Terminal nodes — no outgoing edges.
        break;
    }

    // Optional no-reply timeout edge — additive on the suspending node
    // types (send_buttons / send_list / collect_input).
    const timeoutTarget = (
      node.config as { timeout?: { timeout_node_key?: string } }
    ).timeout?.timeout_node_key;
    if (
      (node.node_type === "send_buttons" ||
        node.node_type === "send_list" ||
        node.node_type === "collect_input") &&
      timeoutTarget &&
      knownKeys.has(timeoutTarget)
    ) {
      edges.push({
        id: `${node.node_key}--timeout--${timeoutTarget}`,
        source: node.node_key,
        target: timeoutTarget,
        sourceHandle: "timeout",
        label: "sem resposta",
      });
    }
  }

  return edges;
}

/** True for node types that can carry an optional no-reply timeout path. */
function canHaveTimeout(nodeType: BuilderNode["node_type"]): boolean {
  return (
    nodeType === "send_buttons" ||
    nodeType === "send_list" ||
    nodeType === "collect_input"
  );
}

/** The `timeout` outgoing slot when a node has a timeout configured. */
function timeoutSlots(node: BuilderNode): OutgoingSlot[] {
  if (!canHaveTimeout(node.node_type)) return [];
  const t = (node.config as { timeout?: unknown }).timeout;
  return t ? [{ id: "timeout", label: "Sem resposta" }] : [];
}

// ============================================================
// Inverse operations — used by the canvas's drag-to-connect and
// delete-with-cleanup handlers (PR 2b). Kept in lib/flows so the
// canvas component stays free of edge-bookkeeping logic.
// ============================================================

/**
 * Outgoing-slot list for a node — used by the canvas to render one
 * source-side Handle per slot, labelled with the slot's user-facing
 * name. Order follows the order the slots appear in the node's
 * config so visual layout matches the form layout.
 *
 * Terminal nodes (handoff / end) return an empty list — they have
 * no outgoing edges and no source handles.
 */
export interface OutgoingSlot {
  /** Stable id matching the `sourceHandle` scheme used in
   *  CanvasEdge. */
  id: string;
  /** Visible label rendered next to the handle. */
  label: string;
}

export function outgoingSlots(node: BuilderNode): OutgoingSlot[] {
  const cfg = node.config;
  switch (node.node_type) {
    case "start":
    case "send_message":
    case "send_media":
    case "set_tag":
    case "action":
    case "delay":
    case "jump":
      return [{ id: "next", label: "Next" }];

    case "collect_input":
      // Own case so the optional timeout slot can be appended.
      return [{ id: "next", label: "Next" }, ...timeoutSlots(node)];

    case "condition":
      return [
        { id: "true", label: "true" },
        { id: "false", label: "false" },
      ];

    case "http_fetch":
      return [
        { id: "next", label: "OK" },
        { id: "error", label: "Erro" },
      ];

    case "randomizer": {
      const branches = Array.isArray((cfg as { branches?: unknown }).branches)
        ? ((cfg as { branches: Array<Record<string, unknown>> }).branches)
        : [];
      const total = branches.reduce<number>(
        (s, b) =>
          s + (typeof b.weight === "number" ? Math.max(0, b.weight) : 0),
        0,
      );
      return branches
        .filter((b) => typeof b.id === "string" && b.id)
        .map((b) => {
          const id = b.id as string;
          const w = typeof b.weight === "number" ? Math.max(0, b.weight) : 0;
          const pct = total > 0 ? Math.round((w / total) * 100) : 0;
          return { id: `branch:${id}`, label: `${pct}%` };
        });
    }

    case "send_buttons": {
      const buttons = Array.isArray((cfg as { buttons?: unknown }).buttons)
        ? ((cfg as { buttons: Array<Record<string, unknown>> }).buttons)
        : [];
      return [
        ...buttons
          .filter((b) => typeof b.reply_id === "string" && b.reply_id)
          .map((b) => {
            const replyId = b.reply_id as string;
            const title = typeof b.title === "string" ? b.title : null;
            return {
              id: `button:${replyId}`,
              label: title ?? replyId,
            };
          }),
        ...timeoutSlots(node),
      ];
    }

    case "send_list": {
      const sections = Array.isArray((cfg as { sections?: unknown }).sections)
        ? ((cfg as { sections: Array<Record<string, unknown>> }).sections)
        : [];
      const slots: OutgoingSlot[] = [];
      for (const section of sections) {
        const rows = Array.isArray(section.rows)
          ? (section.rows as Array<Record<string, unknown>>)
          : [];
        for (const row of rows) {
          const replyId =
            typeof row.reply_id === "string" ? row.reply_id : null;
          if (!replyId) continue;
          const title = typeof row.title === "string" ? row.title : null;
          slots.push({
            id: `row:${replyId}`,
            label: title ?? replyId,
          });
        }
      }
      return [...slots, ...timeoutSlots(node)];
    }

    case "handoff":
    case "end":
      return [];
  }
}

/**
 * Compute the config patch to apply when the user drags an edge from
 * `sourceHandle` on a node to `targetKey`. Returns `null` when the
 * handle isn't recognised on the node type (defensive — React-Flow
 * would have to misroute for this to fire).
 *
 * For `send_buttons` and `send_list`, only the button/row with the
 * matching reply_id is patched; the rest of the array passes through
 * unchanged.
 */
export function applyEdgeConnection(
  node: BuilderNode,
  sourceHandle: string,
  targetKey: string,
): Record<string, unknown> | null {
  // The no-reply timeout handle is shared across the suspending node
  // types — patch it here so each case below stays focused on its own
  // reply-driven edges. Preserve any existing duration.
  if (sourceHandle === "timeout" && canHaveTimeout(node.node_type)) {
    const existing = (
      node.config as {
        timeout?: { duration?: unknown };
      }
    ).timeout;
    return {
      timeout: {
        duration: existing?.duration ?? { value: 1, unit: "hours" },
        timeout_node_key: targetKey,
      },
    };
  }
  switch (node.node_type) {
    case "start":
    case "send_message":
    case "send_media":
    case "collect_input":
    case "set_tag":
    case "action":
    case "delay":
      if (sourceHandle === "next") return { next_node_key: targetKey };
      return null;

    case "jump":
      if (sourceHandle === "next") return { target_node_key: targetKey };
      return null;

    case "condition":
      if (sourceHandle === "true") return { true_next: targetKey };
      if (sourceHandle === "false") return { false_next: targetKey };
      return null;

    case "http_fetch":
      if (sourceHandle === "next") return { next_node_key: targetKey };
      if (sourceHandle === "error") return { error_node_key: targetKey };
      return null;

    case "randomizer": {
      if (!sourceHandle.startsWith("branch:")) return null;
      const branchId = sourceHandle.slice("branch:".length);
      const branches = Array.isArray(
        (node.config as { branches?: unknown }).branches,
      )
        ? (node.config as {
            branches: Array<Record<string, unknown>>;
          }).branches
        : [];
      if (!branches.some((b) => b.id === branchId)) return null;
      return {
        branches: branches.map((b) =>
          b.id === branchId ? { ...b, next_node_key: targetKey } : b,
        ),
      };
    }

    case "send_buttons": {
      if (!sourceHandle.startsWith("button:")) return null;
      const replyId = sourceHandle.slice("button:".length);
      const buttons = Array.isArray(
        (node.config as { buttons?: unknown }).buttons,
      )
        ? (node.config as {
            buttons: Array<Record<string, unknown>>;
          }).buttons
        : [];
      // No matching button → no-op (caller should have surfaced a
      // missing slot before letting the user drag).
      if (!buttons.some((b) => b.reply_id === replyId)) return null;
      return {
        buttons: buttons.map((b) =>
          b.reply_id === replyId ? { ...b, next_node_key: targetKey } : b,
        ),
      };
    }

    case "send_list": {
      if (!sourceHandle.startsWith("row:")) return null;
      const replyId = sourceHandle.slice("row:".length);
      const sections = Array.isArray(
        (node.config as { sections?: unknown }).sections,
      )
        ? (node.config as {
            sections: Array<Record<string, unknown>>;
          }).sections
        : [];
      let matched = false;
      const next = sections.map((s) => {
        const rows = Array.isArray(s.rows)
          ? (s.rows as Array<Record<string, unknown>>)
          : [];
        return {
          ...s,
          rows: rows.map((r) => {
            if (r.reply_id === replyId) {
              matched = true;
              return { ...r, next_node_key: targetKey };
            }
            return r;
          }),
        };
      });
      return matched ? { sections: next } : null;
    }

    case "handoff":
    case "end":
      return null;
  }
}

/**
 * Walk every node and clear any `next_node_key` / `true_next` /
 * `false_next` / `button.next_node_key` / `row.next_node_key`
 * reference to `deletedKey`. Cleared refs become the empty string —
 * the same "no target picked" sentinel the builder forms use.
 *
 * Returns a new array; original nodes are left untouched. Nodes
 * without any matching reference pass through by identity to avoid
 * needless re-renders downstream.
 */
export function unlinkNodeReferences(
  nodes: BuilderNode[],
  deletedKey: string,
): BuilderNode[] {
  return nodes.map((n) => {
    const patched = patchedConfigWithoutKey(n, deletedKey);
    return patched ? { ...n, config: patched } : n;
  });
}

function patchedConfigWithoutKey(
  node: BuilderNode,
  deletedKey: string,
): Record<string, unknown> | null {
  const base = basePatchWithoutKey(node, deletedKey);
  // Also clear a no-reply timeout target that points at the deleted node.
  // Merges on top of `base` so a node that references `deletedKey` from BOTH
  // a reply edge and its timeout gets both cleared.
  const to = (node.config as { timeout?: { timeout_node_key?: string } })
    .timeout;
  if (to && to.timeout_node_key === deletedKey) {
    return {
      ...(base ?? node.config),
      timeout: { ...to, timeout_node_key: "" },
    };
  }
  return base;
}

function basePatchWithoutKey(
  node: BuilderNode,
  deletedKey: string,
): Record<string, unknown> | null {
  const cfg = node.config;
  switch (node.node_type) {
    case "start":
    case "send_message":
    case "send_media":
    case "collect_input":
    case "set_tag":
    case "action":
    case "delay": {
      const next = (cfg as { next_node_key?: string }).next_node_key;
      if (next !== deletedKey) return null;
      return { ...cfg, next_node_key: "" };
    }

    case "jump": {
      const next = (cfg as { target_node_key?: string }).target_node_key;
      if (next !== deletedKey) return null;
      return { ...cfg, target_node_key: "" };
    }

    case "randomizer": {
      const branches = Array.isArray((cfg as { branches?: unknown }).branches)
        ? (cfg as { branches: Array<Record<string, unknown>> }).branches
        : [];
      if (!branches.some((b) => b.next_node_key === deletedKey)) return null;
      return {
        ...cfg,
        branches: branches.map((b) =>
          b.next_node_key === deletedKey ? { ...b, next_node_key: "" } : b,
        ),
      };
    }

    case "condition": {
      const c = cfg as { true_next?: string; false_next?: string };
      const trueMatch = c.true_next === deletedKey;
      const falseMatch = c.false_next === deletedKey;
      if (!trueMatch && !falseMatch) return null;
      return {
        ...cfg,
        ...(trueMatch ? { true_next: "" } : {}),
        ...(falseMatch ? { false_next: "" } : {}),
      };
    }

    case "http_fetch": {
      const c = cfg as { next_node_key?: string; error_node_key?: string };
      const nMatch = c.next_node_key === deletedKey;
      const eMatch = c.error_node_key === deletedKey;
      if (!nMatch && !eMatch) return null;
      return {
        ...cfg,
        ...(nMatch ? { next_node_key: "" } : {}),
        ...(eMatch ? { error_node_key: "" } : {}),
      };
    }

    case "send_buttons": {
      const buttons = Array.isArray((cfg as { buttons?: unknown }).buttons)
        ? (cfg as {
            buttons: Array<Record<string, unknown>>;
          }).buttons
        : [];
      if (!buttons.some((b) => b.next_node_key === deletedKey)) return null;
      return {
        ...cfg,
        buttons: buttons.map((b) =>
          b.next_node_key === deletedKey ? { ...b, next_node_key: "" } : b,
        ),
      };
    }

    case "send_list": {
      const sections = Array.isArray((cfg as { sections?: unknown }).sections)
        ? (cfg as {
            sections: Array<Record<string, unknown>>;
          }).sections
        : [];
      let dirty = false;
      const next = sections.map((s) => {
        const rows = Array.isArray(s.rows)
          ? (s.rows as Array<Record<string, unknown>>)
          : [];
        return {
          ...s,
          rows: rows.map((r) => {
            if (r.next_node_key === deletedKey) {
              dirty = true;
              return { ...r, next_node_key: "" };
            }
            return r;
          }),
        };
      });
      return dirty ? { ...cfg, sections: next } : null;
    }

    case "handoff":
    case "end":
      return null;
  }
}

