/** A small glowing jack-o'-lantern that flickers like a candle (halloween.css). */
export function PumpkinDot({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={`halloween-pumpkin ${className ?? ''}`} aria-hidden="true" focusable="false">
      <path d="M12 5.5c.3-1.6 1.2-2.6 2.6-3" stroke="#4d7c0f" strokeWidth="1.8" strokeLinecap="round" fill="none" />
      <ellipse cx="7.6" cy="14" rx="5.4" ry="7" fill="#e8620c" />
      <ellipse cx="16.4" cy="14" rx="5.4" ry="7" fill="#e8620c" />
      <ellipse cx="12" cy="14" rx="5" ry="7.4" fill="#ff7a1a" />
      <path
        className="face"
        fill="#ffd166"
        d="M7.2 11.6l2.2-1.8.8 2.6zM16.8 11.6l-2.2-1.8-.8 2.6zM7 15.4c1.4 2.4 8.6 2.4 10 0-.8.5-1.6.7-2.2.6l-.7 1-.9-.9h-2.4l-.9.9-.7-1c-.6.1-1.4-.1-2.2-.6z"
      />
    </svg>
  )
}
