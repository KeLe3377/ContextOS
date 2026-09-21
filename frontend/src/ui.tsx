import { ReactNode } from "react";

/**
 * 共享基础展示件。
 *
 * 从 App.tsx 原样抽出，供页面与自动化组件共用，避免组件反向依赖 App 造成循环引用。
 * 这里只放展示，不放业务判断。
 */

export function fmtDate(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString() : "-";
}

export function toneForStatus(status: string | null | undefined) {
  if (["ACTIVE", "RUNNING", "READY", "SUCCEEDED", "DONE", "ACCEPTED", "RESOLVED", "VALID"].includes(String(status))) return "green";
  if (["OPEN", "DRAFT", "PROPOSED", "CREATED", "IN_PROGRESS", "IN_REVIEW"].includes(String(status))) return "blue";
  if (["BLOCKED", "PAUSED", "DISABLED", "STALE"].includes(String(status))) return "amber";
  if (["FAILED", "CANCELED", "ARCHIVED", "INVALID", "DISMISSED"].includes(String(status))) return "red";
  return "";
}

export function Badge({ text, tone = "" }: { text: ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}>{text}</span>;
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return <div className="empty-note">{children}</div>;
}

export function Panel({ title, iconName, children, meta = "" }: { title: string; iconName: string; children: ReactNode; meta?: ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <div className="panel-title">{icon(iconName)}{title}</div>
        <div className="panel-meta mono">{meta}</div>
      </div>
      {children}
    </section>
  );
}

export function Rows({ rows, empty = "暂无条目。" }: { rows: Array<[ReactNode, ReactNode, string, ReactNode?]>; empty?: string }) {
  if (!rows.length) return <EmptyNote>{empty}</EmptyNote>;
  return (
    <div>
      {rows.map(([title, status, tone, sub], index) => (
        <div className="list-row" key={index}>
          <div>
            <div className="title-sm">{title}</div>
            {sub ? <div className="muted">{sub}</div> : null}
          </div>
          <Badge text={status} tone={tone} />
        </div>
      ))}
    </div>
  );
}

/** 与 App 内一致的图标渲染，避免基础件依赖 App。 */
function icon(name: string) {
  return <span className="material-symbols-outlined" aria-hidden="true">{name}</span>;
}
