// Shared by the change-password form (client hint) and its server action
// (the actual enforcement). Kept in one place so the two can't drift.
export const MIN_PASSWORD_LENGTH = 10;

// Returns an error message, or null if the new password is acceptable.
export function validateNewPassword(next: string, confirm: string, current: string): string | null {
  if (next.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (next !== confirm) return "The two new passwords don't match.";
  if (next === current) return "Choose a password different from your current one.";
  return null;
}
