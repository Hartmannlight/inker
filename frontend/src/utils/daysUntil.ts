// Compatibility import path; the domain implementation is shared with every client.
export {
  addCountedDays,
  calculateDaysUntil,
  countDays,
  formatLocalDate,
  parseLocalDate,
  type DaysUntilInputMode,
  type DaysUntilDayMode,
  type DaysUntilCalculationConfig,
  type DaysUntilCalculation,
} from '@inker/contracts';
export type DaysUntilDesign = 'text' | 'progressBar' | 'compact' | 'segments';
