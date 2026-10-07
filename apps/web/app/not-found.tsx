import Link from 'next/link';
export default function NotFound() {
  return (
    <div className="state" role="alert">
      <h1>404 · 페이지를 찾을 수 없습니다</h1>
      <p className="muted">Page not found. 이전 WONT Travel Club 주소라면 새 주소로 자동 이동됩니다.</p>
      <Link className="btn primary" href="/">
        홈으로 / Home
      </Link>
    </div>
  );
}
