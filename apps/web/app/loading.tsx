export default function Loading() {
  return (
    <div role="status" aria-live="polite" className="center" style={{ padding: 48 }}>
      <div className="spinner" aria-hidden="true" />
      <span className="muted small">불러오는 중… / Loading…</span>
    </div>
  );
}
