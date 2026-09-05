"use client";

// The raw pager feed — everything that came over the air, before the board's
// filter. Where PagerBoard shows parsed, merged, numbered incidents, this shows
// the lines themselves: SES traffic, stand-downs, test pages and decode noise
// included, each tagged with what the pipeline did with it.
//
// Identical lines are collapsed server-side (see supabase/schema.sql), so a page
// picked up by three sources is one row listing all three.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { PagerMessage, RawStatus } from "@/lib/types";
import { getBrowserClient } from "@/lib/supabase-browser";
import { fmtTime as fmt, dateKey, relativeAge } from "@/lib/time";

// Only the exceptions get a tag. "On board" is the expected outcome for most
// traffic, so badging every row with it is noise that buries the interesting
// ones — the row's left accent bar carries that state instead.
const STATUS_TAG: Partial<Record<RawStatus, string>> = {
  standdown: "STAND DOWN",
  dropped: "DROPPED",
};

// The filter chips. `null` = no status filter.
const FILTERS: { key: string; label: string; status: RawStatus | null }[] = [
  { key: "all", label: "All", status: null },
  { key: "incident", label: "On board", status: "incident" },
  { key: "standdown", label: "Stand-downs", status: "standdown" },
  { key: "dropped", label: "Dropped", status: "dropped" },
];

const PAGE_SIZE = 200;
const SEARCH_DEBOUNCE_MS = 300;

// Combine pages keyed by hash, newest first. Later lists win, so a refresh's
// fresh rows (with updated seen_count) replace stale copies.
function mergeByHash(...lists: PagerMessage[][]): PagerMessage[] {
  const byHash = new Map<string, PagerMessage>();
  for (const list of lists) for (const m of list) byHash.set(m.hash, m);
  return [...byHash.values()].sort((a, b) =>
    a.receivedAt < b.receivedAt ? 1 : a.receivedAt > b.receivedAt ? -1 : 0,
  );
}

export default function RawFeed({ getToken }: { getToken: () => string | null }) {
  const [messages, setMessages] = useState<PagerMessage[]>([]);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");   // debounced copy of `search`
  const [filter, setFilter] = useState("all");
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  // Drives the relative-age gutter. Starts null so the server and the first
  // client render agree; ticks slowly because the column is coarse (m/h/d).
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const messagesRef = useRef<PagerMessage[]>([]);
  const loadingRef = useRef(false);
  const sentinelRef = useRef<HTMLTableRowElement | null>(null);
  // Lets the Realtime subscription call the *current* refresh without listing it
  // as a dependency — otherwise every keystroke would tear down the channel.
  const refreshRef = useRef<() => void>(() => {});
  const throttleRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // Search hits the server (the table holds everything, so filtering only the
  // loaded page would quietly miss most of it) — debounce so each keystroke
  // isn't a query.
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  const status = FILTERS.find((f) => f.key === filter)?.status ?? null;

  // Fetch one page. Pass the oldest row you have to page backwards; omit it for
  // the newest page. Returns null on failure so callers keep what they have.
  const fetchPage = useCallback(
    async (before?: PagerMessage): Promise<PagerMessage[] | null> => {
      try {
        const token = getToken();
        const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
        if (before) {
          params.set("before", before.receivedAt);
          params.set("beforeHash", before.hash);
        }
        if (query) params.set("q", query);
        if (status) params.set("status", status);

        const res = await fetch(`/api/raw?${params}`, {
          cache: "no-store",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) return null;
        const data = await res.json();
        return Array.isArray(data.messages) ? data.messages : [];
      } catch {
        return null;
      }
    },
    [getToken, query, status],
  );

  // Pull the newest page. A short page means it's the whole result set, so treat
  // it as authoritative; a full page means older rows exist below it.
  const refresh = useCallback(async () => {
    const page = await fetchPage();
    if (!page) return;
    if (page.length < PAGE_SIZE) {
      setMessages(page);
      setHasMore(false);
    } else {
      setMessages((prev) => mergeByHash(prev, page));
      if (messagesRef.current.length === 0) setHasMore(true);
    }
    setLoading(false);
  }, [fetchPage]);

  // Append the next older page. Fired by the scroll sentinel below.
  async function loadMore() {
    if (loadingRef.current || !hasMore) return;
    const oldest = messagesRef.current[messagesRef.current.length - 1];
    if (!oldest) return;
    loadingRef.current = true;
    setLoadingMore(true);
    const page = await fetchPage(oldest);
    if (page) {
      setMessages((prev) => mergeByHash(prev, page));
      if (page.length < PAGE_SIZE) setHasMore(false);
    }
    loadingRef.current = false;
    setLoadingMore(false);
  }

  useEffect(() => { refreshRef.current = refresh; }, [refresh]);

  // Reset and reload whenever the query or the status filter changes — the
  // keyset cursor from the previous result set doesn't apply to the new one.
  useEffect(() => {
    setMessages([]);
    messagesRef.current = [];
    setHasMore(false);
    setLoading(true);
    refresh();
  }, [refresh]);

  // Live pushes, plus the same resilience the board has: a heartbeat poll in
  // case the Realtime socket drops, and a re-pull whenever a backgrounded PWA
  // comes back to the foreground with frozen timers and a dead socket.
  //
  // Mounted once (the handlers go through refreshRef), and Realtime events are
  // coalesced: this table sees every line off every source, so a busy minute
  // would otherwise fire a full page fetch per message.
  useEffect(() => {
    const nudge = () => {
      if (throttleRef.current) return;
      throttleRef.current = setTimeout(() => {
        throttleRef.current = null;
        refreshRef.current();
      }, 1500);
    };

    const channel = getBrowserClient()
      .channel("pager-messages-live")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "pager_messages" },
        nudge,
      )
      .subscribe();

    const t = setInterval(() => refreshRef.current(), 30_000);

    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      refreshRef.current();
      if (channel.state !== "joined") channel.subscribe();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener("pageshow", onVisible);

    return () => {
      getBrowserClient().removeChannel(channel);
      clearInterval(t);
      if (throttleRef.current) clearTimeout(throttleRef.current);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("pageshow", onVisible);
    };
  }, []);

  const grouped = useMemo(() => {
    const map = new Map<string, PagerMessage[]>();
    for (const m of messages) {
      const d = dateKey(m.receivedAt);
      if (!map.has(d)) map.set(d, []);
      map.get(d)!.push(m);
    }
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [messages]);

  // Load older rows as the sentinel nears the viewport, ~600px early so
  // scrolling stays smooth. Re-runs when `hasMore` flips (which mounts and
  // unmounts the sentinel) and after each load, so a still-visible sentinel
  // keeps paging.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    const obs = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) loadMore(); },
      { rootMargin: "600px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMore, loadingMore]);

  return (
    <div className="app">
      <header className="topbar">
        <Link className="back-btn" href="/" aria-label="Back to the board">
          <span aria-hidden="true">←</span> Board
        </Link>

        <div className="raw-title">
          Raw feed
          <span className="raw-sub">unfiltered pager traffic</span>
        </div>

        <div className="topbar-spacer" />

        <div className="raw-readout">
          <span className="raw-readout-n">{messages.length.toLocaleString()}</span>
          <span className="raw-readout-l">{hasMore ? "loaded" : "messages"}</span>
        </div>

        <label className="search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
          </svg>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search every line…"
            enterKeyHint="search"
          />
          {search && (
            <button className="search-clear" onClick={() => setSearch("")} aria-label="Clear search">×</button>
          )}
        </label>
      </header>

      <div className="raw-filters">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={`chip${filter === f.key ? " on" : ""}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="list-wrap">
        <table className="raw-table">
          <thead>
            <tr>
              <th style={{ width: 62 }}>Time</th>
              <th style={{ width: 82 }}>Capcode</th>
              <th style={{ width: 130 }}>Agency</th>
              <th style={{ width: 190 }}>Unit</th>
              <th>Message</th>
              <th style={{ width: 150 }}>Src</th>
            </tr>
          </thead>
          <tbody>
            {grouped.map(([date, rows]) => (
              <Fragment key={date}>
                <tr className="date-row">
                  <td colSpan={6}>{date}</td>
                </tr>
                {rows.map((m) => (
                  <tr key={m.hash} className={`data-row raw-row ${m.status}`}>
                    <td>
                      <span className="time-cell">{fmt(m.receivedAt)}</span>
                      {now && <span className="raw-age">{relativeAge(m.receivedAt, now)}</span>}
                    </td>
                    <td>
                      {m.capcode
                        ? <span className="capcode">{m.capcode}</span>
                        : <span className="dim">·</span>}
                    </td>
                    <td>
                      {m.agency
                        ? <span className="agency-tag">{m.agency}</span>
                        : <span className="dim">·</span>}
                    </td>
                    <td>
                      {m.origin
                        ? <span className="origin-cell">{m.origin}</span>
                        : <span className="dim">·</span>}
                    </td>
                    <td>
                      <div className="raw-line">
                        {STATUS_TAG[m.status] && (
                          <span className={`raw-status ${m.status}`}>{STATUS_TAG[m.status]}</span>
                        )}
                        {m.raw}
                      </div>
                    </td>
                    <td>
                      <div className="cs-cell">
                        {m.sources.length > 0
                          ? m.sources.map((s) => <span key={s} className="badge">{s}</span>)
                          : <span className="dim" title="Reconstructed from the board — predates the raw feed">·</span>}
                        {m.seenCount > 1 && (
                          <span
                            className="seen-count"
                            title={`Reported ${m.seenCount} times — last at ${fmt(m.lastSeenAt, true)}`}
                          >
                            ×{m.seenCount}
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </Fragment>
            ))}
            {hasMore && (
              <tr ref={sentinelRef} className="load-sentinel">
                <td colSpan={6}>{loadingMore ? "Loading earlier messages…" : ""}</td>
              </tr>
            )}
          </tbody>
        </table>

        {messages.length === 0 && (
          <div className="empty">
            {loading
              ? "Loading…"
              : query
                ? `No messages matching "${query}"`
                : "No messages yet."}
          </div>
        )}
      </div>
    </div>
  );
}
