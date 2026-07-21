/**
 * Group management.
 *
 * A position belongs to at most one group, so assigning it somewhere new
 * removes it from wherever it was — the UI mirrors that rather than pretending
 * multi-membership is possible.
 */

import { useMemo, useState } from "react";
import { isBond, isOption, type Position } from "@onebook/finance";
import type { ApiGroup } from "../api.js";
import type { GroupsState } from "../store.js";

/** A small fixed palette beats a color picker for something this incidental. */
const COLORS = ["olive", "teal", "violet", "amber", "slate"];

function positionLabel(p: Position): string {
  if (isOption(p)) {
    return `${p.ticker} ${p.right === "call" ? "C" : "P"}${p.strike}`;
  }
  if (isBond(p)) return `${p.ticker} bond`;
  return `${p.ticker} ${p.quantity} sh`;
}

export function ManageGroupsModal({
  groups,
  positions,
  actions,
  onClose,
}: {
  groups: ApiGroup[];
  positions: Position[];
  actions: GroupsState;
  onClose: () => void;
}) {
  const [newName, setNewName] = useState("");

  const assignedIds = useMemo(
    () => new Set(groups.flatMap((g) => g.positionIds)),
    [groups],
  );
  const unassigned = positions.filter((p) => !assignedIds.has(p.id));

  const cycleColor = (group: ApiGroup) => {
    const next = COLORS[(COLORS.indexOf(group.color) + 1) % COLORS.length];
    void actions.update(group.id, { color: next });
  };

  return (
    <div className="backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Manage groups</h2>
          <button className="icon" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="modal-body">
          {groups.length === 0 && (
            <p className="faint" style={{ fontSize: "0.6875rem", marginTop: 0 }}>
              Groups let you split one book into named buckets — by strategy,
              account, or anything else.
            </p>
          )}

          {groups.map((group) => (
            <div className="group-block" key={group.id}>
              <div className="group-head">
                <button
                  className={`swatch swatch-${group.color}`}
                  onClick={() => cycleColor(group)}
                  aria-label={`Change color for ${group.name}`}
                />
                <input
                  aria-label={`Name for ${group.name}`}
                  defaultValue={group.name}
                  onBlur={(e) => {
                    const value = e.target.value.trim();
                    if (value && value !== group.name) {
                      void actions.update(group.id, { name: value });
                    }
                  }}
                />
                <button
                  onClick={() => void actions.remove(group.id)}
                  aria-label={`Delete ${group.name}`}
                >
                  Delete
                </button>
              </div>

              <div className="group-members">
                {group.positionIds.length === 0 ? (
                  <span className="faint">Nothing assigned yet.</span>
                ) : (
                  group.positionIds.map((id) => {
                    const position = positions.find((p) => p.id === id);
                    if (!position) return null;
                    return (
                      <span className="chip" key={id}>
                        {positionLabel(position)}
                        <button
                          className="icon"
                          aria-label={`Remove ${position.ticker} from ${group.name}`}
                          onClick={() => void actions.unassign(group.id, id)}
                        >
                          ✕
                        </button>
                      </span>
                    );
                  })
                )}
              </div>
            </div>
          ))}

          <div className="field">
            <label htmlFor="new-group">New group</label>
            <div style={{ display: "flex", gap: "var(--s2)" }}>
              <input
                id="new-group"
                value={newName}
                placeholder="Income strategies"
                onChange={(e) => setNewName(e.target.value)}
              />
              <button
                className="primary"
                disabled={!newName.trim()}
                onClick={() => {
                  void actions.create(newName.trim(), COLORS[0]);
                  setNewName("");
                }}
              >
                Create
              </button>
            </div>
          </div>

          <h3 className="section-title">Unassigned</h3>
          {unassigned.length === 0 ? (
            <p className="faint" style={{ fontSize: "0.6875rem" }}>
              {positions.length === 0
                ? "No positions to assign yet."
                : "All instruments assigned."}
            </p>
          ) : (
            unassigned.map((position) => (
              <div className="group-assign-row" key={position.id}>
                <span>{positionLabel(position)}</span>
                <select
                  aria-label={`Add ${position.ticker} to a group`}
                  value=""
                  disabled={groups.length === 0}
                  onChange={(e) => {
                    if (e.target.value) {
                      void actions.assign(e.target.value, position.id);
                    }
                  }}
                >
                  <option value="">
                    {groups.length === 0 ? "Create a group first" : "Add to…"}
                  </option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </div>
            ))
          )}
        </div>

        <div className="modal-foot">
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
