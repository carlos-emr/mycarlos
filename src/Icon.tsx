import type { ReactNode } from "react";

export type IconName =
  | "activity"
  | "camera"
  | "clock"
  | "flask"
  | "folder"
  | "folder-plus"
  | "grid"
  | "heart"
  | "image"
  | "info"
  | "letter"
  | "list"
  | "lock-open"
  | "more"
  | "pill"
  | "plus"
  | "reset"
  | "search"
  | "shield"
  | "sort"
  | "star"
  | "trash";

export function Icon({ name }: { name: IconName }) {
  let content: ReactNode;

  switch (name) {
    case "heart":
      content = (
        <path d="M20.8 4.7a5.5 5.5 0 0 0-7.8 0L12 5.8l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.5a5.5 5.5 0 0 0 0-7.8Z" />
      );
      break;
    case "activity":
      content = (
        <>
          <path d="M3 12h4l2.5-7 5 14 2.5-7h4" />
          <path d="M20.8 4.7a5.5 5.5 0 0 0-7.8 0L12 5.8l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.5a5.5 5.5 0 0 0 0-7.8Z" />
        </>
      );
      break;
    case "folder":
      content = <path d="M3 6.5h6l2 2H21v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />;
      break;
    case "folder-plus":
      content = (
        <>
          <path d="M3 7h6l2 2h10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
          <path d="M12 12v5M9.5 14.5h5" />
        </>
      );
      break;
    case "clock":
      content = (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3.5 2" />
        </>
      );
      break;
    case "star":
      content = (
        <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9Z" />
      );
      break;
    case "trash":
      content = (
        <>
          <path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" />
        </>
      );
      break;
    case "flask":
      content = (
        <>
          <path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 18l-5-9V3" />
          <path d="M7.5 15h9" />
        </>
      );
      break;
    case "letter":
      content = (
        <>
          <path d="M4 7h16v12H4Z" />
          <path d="m4 8 8 6 8-6M8 4h8" />
        </>
      );
      break;
    case "image":
      content = (
        <>
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <circle cx="9" cy="9" r="1.5" />
          <path d="m5 18 5-5 3 3 2-2 4 4" />
        </>
      );
      break;
    case "pill":
      content = (
        <>
          <path d="M7.2 5.2a3 3 0 0 1 4.2 0l1.4 1.4a3 3 0 0 1 0 4.2l-2 2a3 3 0 0 1-4.2 0l-1.4-1.4a3 3 0 0 1 0-4.2Z" />
          <path d="m7 10 3-3M14 13l5 5M13 17l4-4" />
        </>
      );
      break;
    case "shield":
      content = <path d="M12 3 5 6v5c0 4.7 2.9 8 7 10 4.1-2 7-5.3 7-10V6Z" />;
      break;
    case "plus":
      content = <path d="M12 5v14M5 12h14" />;
      break;
    case "search":
      content = (
        <>
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m16 16 5 5" />
        </>
      );
      break;
    case "sort":
      content = (
        <>
          <path d="M8 5v14M5 16l3 3 3-3M14 7h6M14 12h4M14 17h2" />
        </>
      );
      break;
    case "list":
      content = (
        <>
          <path d="M9 6h11M9 12h11M9 18h11" />
          <circle cx="4" cy="6" r="1" />
          <circle cx="4" cy="12" r="1" />
          <circle cx="4" cy="18" r="1" />
        </>
      );
      break;
    case "grid":
      content = (
        <>
          <rect x="4" y="4" width="6" height="6" />
          <rect x="14" y="4" width="6" height="6" />
          <rect x="4" y="14" width="6" height="6" />
          <rect x="14" y="14" width="6" height="6" />
        </>
      );
      break;
    case "more":
      content = (
        <>
          <circle cx="12" cy="5" r="1" />
          <circle cx="12" cy="12" r="1" />
          <circle cx="12" cy="19" r="1" />
        </>
      );
      break;
    case "lock-open":
      content = (
        <>
          <rect x="5" y="10" width="14" height="10" rx="2" />
          <path d="M9 10V7a4 4 0 0 1 7.5-2" />
        </>
      );
      break;
    case "camera":
      content = (
        <>
          <path d="M4 8h4l1.5-2h5L16 8h4v11H4Z" />
          <circle cx="12" cy="13" r="3" />
        </>
      );
      break;
    case "info":
      content = (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v6M12 7h.01" />
        </>
      );
      break;
    case "reset":
      content = <path d="M4 9V4l3 3a8 8 0 1 1-2 8" />;
      break;
  }

  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      {content}
    </svg>
  );
}
