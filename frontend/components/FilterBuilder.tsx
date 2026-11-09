"use client";
import { useEffect, useState, KeyboardEvent } from "react";
import type { Column, Condition, Group, Operator, Relation } from "@/lib/api";

type Props = {
  value: Group; onChange: (g: Group) => void; columns: Column[]; relations: Relation[]; operators: Operator[];
  parentName: string;
  getValues?: (relatedId: number | undefined, column: string) => Promise<string[]>;
};
type Shared = Omit<Props, "value" | "onChange">;

export const emptyGroup = (): Group => ({ type: "group", op: "and", children: [] });

export function validate(node: Group | Condition, ops: Operator[]): boolean {
  if (node.type === "group") return node.children.every((c) => validate(c, ops));
  const op = ops.find((o) => o.key === node.operator);
  if (!node.property || !op) return false;
  return op.kind === "none" || node.values.some((v) => v.trim() !== "");
}

export default function FilterBuilder({ value, onChange, ...shared }: Props) {
  return <GroupView group={value} onChange={onChange} depth={0} {...shared} />;
}

function firstOp(ops: Operator[], category: string) {
  return ops.find((o) => o.types.includes(category))!.key;
}

function GroupView({
  group, onChange, onRemove, depth, ...shared
}: { group: Group; onChange: (g: Group) => void; onRemove?: () => void; depth: number } & Shared) {
  const { columns, operators } = shared;
  const set = (i: number, child: Group | Condition) =>
    onChange({ ...group, children: group.children.map((c, j) => (j === i ? child : c)) });
  const remove = (i: number) => onChange({ ...group, children: group.children.filter((_, j) => j !== i) });
  const addCondition = () => {
    const col = columns[0];
    onChange({ ...group, children: [...group.children, { type: "condition", property: col?.name ?? "", operator: firstOp(operators, col?.category ?? "string"), values: [] }] });
  };
  const addGroup = () => onChange({ ...group, children: [...group.children, { ...emptyGroup(), op: group.op === "and" ? "or" : "and" }] });

  return (
    <div className={depth ? "group nested" : "group"}>
      {group.children.length === 0 && <div className="muted">No conditions — everyone in the model matches.</div>}
      {group.children.map((child, i) => (
        <div key={i} className="row">
          <div className="joiner">
            {i === 0 ? (
              <span className="muted">Where</span>
            ) : i === 1 ? (
              <select value={group.op} onChange={(e) => onChange({ ...group, op: e.target.value as "and" | "or" })}>
                <option value="and">and</option>
                <option value="or">or</option>
              </select>
            ) : (
              <span className="muted">{group.op}</span>
            )}
          </div>
          <div className="grow">
            {child.type === "group" ? (
              <GroupView group={child} onChange={(g) => set(i, g)} onRemove={() => remove(i)} depth={depth + 1} {...shared} />
            ) : (
              <ConditionRow cond={child} onChange={(c) => set(i, c)} onRemove={() => remove(i)} {...shared} />
            )}
          </div>
        </div>
      ))}
      <div className="actions">
        <button className="link" onClick={addCondition}>+ Add condition</button>
        {depth < 2 && <button className="link" onClick={addGroup}>+ Add group</button>}
        {onRemove && <button className="link danger" onClick={onRemove}>Remove group</button>}
      </div>
    </div>
  );
}

function ConditionRow({
  cond, onChange, onRemove, columns, relations, operators, parentName, getValues,
}: { cond: Condition; onChange: (c: Condition) => void; onRemove: () => void } & Shared) {
  const relation = relations.find((r) => r.id === cond.related_id);
  const cols = relation ? relation.columns : columns;
  const category = cols.find((c) => c.name === cond.property)?.category ?? "string";
  const available = operators.filter((o) => o.types.includes(category));
  const op = operators.find((o) => o.key === cond.operator);
  const anyRecord = !!relation && !cond.property;
  const missing = !anyRecord && op && op.kind !== "none" && !cond.values.some((v) => v.trim() !== "");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  useEffect(() => {
    setSuggestions([]);
    if (getValues && cond.property && category === "string") getValues(cond.related_id, cond.property).then(setSuggestions).catch(() => {});
  }, [cond.related_id, cond.property]);

  const changeScope = (v: string) => {
    const rel = relations.find((r) => r.id === +v);
    const target = rel ? rel.columns : columns;
    const col = rel ? undefined : target[0]; // related models default to "any record"
    const next: Condition = { type: "condition", property: col?.name ?? "", operator: firstOp(operators, col?.category ?? "string"), values: [] };
    if (rel) { next.related_id = rel.id; next.has = true; }
    onChange(next);
  };

  const changeProp = (name: string) => {
    if (!name) return onChange({ ...cond, property: "", values: [] });
    const cat = cols.find((c) => c.name === name)?.category ?? "string";
    const stillValid = operators.find((o) => o.key === cond.operator)?.types.includes(cat);
    onChange({ ...cond, property: name, operator: stillValid ? cond.operator : firstOp(operators, cat), values: stillValid ? cond.values : [] });
  };

  return (
    <div className="cond">
      {relations.length > 0 ? (
        <select value={cond.related_id ?? ""} onChange={(e) => changeScope(e.target.value)}>
          <option value="">{parentName} property</option>
          {relations.map((r) => <option key={r.id} value={r.id}>Related: {r.name}</option>)}
        </select>
      ) : <span className="muted">Have property</span>}
      {relation && (
        <>
          <select value={cond.count_op ?? (cond.has === false ? "none" : "any")}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "any") onChange({ ...cond, has: true, count_op: undefined, count: undefined });
              else if (v === "none") onChange({ ...cond, has: false, count_op: undefined, count: undefined });
              else onChange({ ...cond, has: true, count_op: v, count: cond.count ?? "1" });
            }}>
            <option value="any">has any where</option>
            <option value="none">has none where</option>
            <option value="at_least">has at least</option>
            <option value="at_most">has at most</option>
            <option value="exactly">has exactly</option>
          </select>
          {cond.count_op && (
            <>
              <input type="number" min={0} style={{ width: 70 }} value={cond.count ?? ""} onChange={(e) => onChange({ ...cond, count: e.target.value })} />
              <span className="muted">rows where</span>
            </>
          )}
        </>
      )}
      <select value={cond.property} onChange={(e) => changeProp(e.target.value)}>
        {relation && <option value="">(any record)</option>}
        {cols.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
      </select>
      {!anyRecord && (
        <select value={cond.operator} onChange={(e) => onChange({ ...cond, operator: e.target.value, values: [] })}>
          {available.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
      )}
      {!anyRecord && op?.kind === "multi" && <ChipInput values={cond.values} onChange={(values) => onChange({ ...cond, values })} invalid={!!missing} suggestions={suggestions} />}
      {!anyRecord && op?.kind === "single" && (
        <input type={category === "date" ? "date" : category === "number" ? "number" : "text"} className={missing ? "invalid" : ""}
          value={cond.values[0] ?? ""} onChange={(e) => onChange({ ...cond, values: [e.target.value] })} placeholder="value" />
      )}
      {!anyRecord && op?.kind === "days" && (
        <input type="number" min={0} className={missing ? "invalid" : ""} value={cond.values[0] ?? ""} onChange={(e) => onChange({ ...cond, values: [e.target.value] })} placeholder="days" />
      )}
      {relation?.kind === "event" && (
        <span className="cond">
          <span className="muted">in the last</span>
          <input type="number" min={0} style={{ width: 70 }} value={cond.event_days ?? ""} onChange={(e) => onChange({ ...cond, event_days: e.target.value })} placeholder="∞" />
          <span className="muted">days</span>
          {[7, 30, 90].map((d) => (
            <button key={d} className={"chip-btn" + (cond.event_days === String(d) ? " on" : "")} onClick={() => onChange({ ...cond, event_days: String(d) })}>{d}d</button>
          ))}
        </span>
      )}
      {missing && <span className="err">This field is required</span>}
      <button className="icon" title="Remove" onClick={onRemove}>✕</button>
    </div>
  );
}

function ChipInput({ values, onChange, invalid, suggestions = [] }: { values: string[]; onChange: (v: string[]) => void; invalid: boolean; suggestions?: string[] }) {
  const listId = useState(() => "sg-" + Math.random().toString(36).slice(2))[0];
  const [text, setText] = useState("");
  const commit = () => {
    const t = text.trim();
    if (t && !values.includes(t)) onChange([...values, t]);
    setText("");
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") { e.preventDefault(); commit(); }
    if (e.key === "Backspace" && !text && values.length) onChange(values.slice(0, -1));
  };
  return (
    <div className={"chips" + (invalid ? " invalid" : "")}>
      {values.map((v) => (
        <span className="chip" key={v}>{v}<button onClick={() => onChange(values.filter((x) => x !== v))}>×</button></span>
      ))}
      <input list={suggestions.length ? listId : undefined} value={text} onChange={(e) => {
        const v = e.target.value;
        if (suggestions.includes(v) && !values.includes(v)) { onChange([...values, v]); setText(""); } else setText(v);
      }} onKeyDown={onKey} onBlur={commit} placeholder="Add values or press Enter" />
      <datalist id={listId}>{suggestions.map((v) => <option key={v} value={v} />)}</datalist>
    </div>
  );
}
