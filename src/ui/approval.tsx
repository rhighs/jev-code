import { useInput } from 'ink';
import type { Session } from './session.js';

export function Approval({ session, active }: { session: Session; active: boolean }) {
  useInput(input => { if (input === 'y' || input === 'n' || input === 'a') session.answer(input); }, { isActive: active });
  return null;
}
