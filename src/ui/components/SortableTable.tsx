import { useMemo, useState, type ReactNode } from "react";
import { MdArrowDropDown, MdArrowDropUp } from "react-icons/md";
import "./SortableTable.css";

type SortDirection = "asc" | "desc";
type SortValue = string | number | boolean | Date | null | undefined;

export interface SortColumn<T> {
  id: string;
  label: string;
  defaultDirection?: SortDirection;
  getValue?: (row: T) => SortValue;
  compare?: (a: T, b: T) => number;
}

interface SortState {
  id: string;
  direction: SortDirection;
}

export interface SortController {
  activeId: string | null;
  direction: SortDirection;
  ariaSort: (id: string) => "ascending" | "descending" | "none";
  labelFor: (id: string) => string;
  toggle: (id: string) => void;
}

interface SortableRowsProps<T> {
  rows: readonly T[];
  columns: readonly SortColumn<T>[];
  children: (rows: T[], sort: SortController) => ReactNode;
}

export function SortableRows<T>({ rows, columns, children }: SortableRowsProps<T>) {
  const [sortState, setSortState] = useState<SortState | null>(null);
  const activeColumn = sortState ? columns.find(column => column.id === sortState.id) ?? null : null;

  const sortedRows = useMemo(() => {
    if (!sortState || !activeColumn) return [...rows];
    const direction = sortState.direction === "asc" ? 1 : -1;
    return rows
      .map((row, index) => ({ row, index }))
      .sort((a, b) => {
        const result = activeColumn.compare
          ? activeColumn.compare(a.row, b.row) * direction
          : compareSortValues(activeColumn.getValue?.(a.row), activeColumn.getValue?.(b.row), sortState.direction);
        return result === 0 ? a.index - b.index : result;
      })
      .map(entry => entry.row);
  }, [activeColumn, rows, sortState]);

  const sort: SortController = {
    activeId: sortState?.id ?? null,
    direction: sortState?.direction ?? "asc",
    ariaSort: (id) => sortState?.id === id ? (sortState.direction === "asc" ? "ascending" : "descending") : "none",
    labelFor: (id) => columns.find(column => column.id === id)?.label ?? id,
    toggle: (id) => {
      const column = columns.find(candidate => candidate.id === id);
      if (!column) return;
      setSortState(current => {
        if (current?.id === id) {
          return { id, direction: current.direction === "asc" ? "desc" : "asc" };
        }
        return { id, direction: column.defaultDirection ?? "asc" };
      });
    },
  };

  return <>{children(sortedRows, sort)}</>;
}

export function SortableTh({ sort, columnId, className = "", title, children }: {
  sort: SortController;
  columnId: string;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  const active = sort.activeId === columnId;
  return (
    <th className={`${className} sortable-th ${active ? "is-sorted" : ""}`.trim()} aria-sort={sort.ariaSort(columnId)} title={title}>
      <SortableHeaderButton sort={sort} columnId={columnId}>
        {children}
      </SortableHeaderButton>
    </th>
  );
}

export function SortableHeaderButton({ sort, columnId, className = "", children }: {
  sort: SortController;
  columnId: string;
  className?: string;
  children: ReactNode;
}) {
  const active = sort.activeId === columnId;
  const DirectionIcon = active ? sort.direction === "asc" ? MdArrowDropUp : MdArrowDropDown : null;
  const label = sort.labelFor(columnId);
  const nextDirection = active && sort.direction === "asc" ? "descending" : "ascending";
  return (
    <button
      type="button"
      className={`sortable-th-button ${className} ${active ? "is-sorted" : ""}`.trim()}
      onClick={() => sort.toggle(columnId)}
      aria-label={`Sort ${label} ${nextDirection}`}
    >
      <span className="sortable-th-label">{children}</span>
      {DirectionIcon && (
        <span className="sortable-th-icon" aria-hidden="true">
          <DirectionIcon />
        </span>
      )}
    </button>
  );
}

function compareSortValues(a: SortValue, b: SortValue, direction: SortDirection): number {
  const aMissing = a == null || a === "";
  const bMissing = b == null || b === "";
  if (aMissing || bMissing) {
    if (aMissing === bMissing) return 0;
    return aMissing ? 1 : -1;
  }

  const av = normalizeSortValue(a);
  const bv = normalizeSortValue(b);
  const result = typeof av === "number" && typeof bv === "number"
    ? av - bv
    : String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: "base" });
  return result * (direction === "asc" ? 1 : -1);
}

function normalizeSortValue(value: Exclude<SortValue, null | undefined>): string | number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}
