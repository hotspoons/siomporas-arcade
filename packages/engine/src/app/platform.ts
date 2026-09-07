// Coarse platform detection for defaults only — nothing gameplay-relevant.

export function isTouchDevice(): boolean {
  return (navigator.maxTouchPoints ?? 0) > 0 && (matchMedia('(pointer: coarse)').matches || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent))
}
