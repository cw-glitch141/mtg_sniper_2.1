/**
 * Porto-Schätzung, übernommen aus Extension v1.1.0 (shared.js → shippingCost).
 * Unbekanntes Land wird vorsichtshalber als Ausland gerechnet.
 */
import type { AppSettings } from './settings.ts';

export const COUNTRIES = [
  { code: 'de', label: 'Deutschland', names: ['deutschland', 'germany', 'de'] },
  { code: 'at', label: 'Österreich', names: ['österreich', 'austria', 'at'] },
  { code: 'ch', label: 'Schweiz', names: ['schweiz', 'switzerland', 'ch'] },
  { code: 'nl', label: 'Niederlande', names: ['niederlande', 'netherlands', 'nl'] },
  { code: 'be', label: 'Belgien', names: ['belgien', 'belgium', 'be'] },
  { code: 'lu', label: 'Luxemburg', names: ['luxemburg', 'luxembourg', 'lu'] },
  { code: 'fr', label: 'Frankreich', names: ['frankreich', 'france', 'fr'] },
  { code: 'it', label: 'Italien', names: ['italien', 'italy', 'it'] },
  { code: 'es', label: 'Spanien', names: ['spanien', 'spain', 'es'] },
  { code: 'pt', label: 'Portugal', names: ['portugal', 'pt'] },
  { code: 'pl', label: 'Polen', names: ['polen', 'poland', 'pl'] },
  { code: 'cz', label: 'Tschechien', names: ['tschechien', 'tschechische republik', 'czech republic', 'czechia', 'cz'] },
  { code: 'dk', label: 'Dänemark', names: ['dänemark', 'denmark', 'dk'] },
  { code: 'se', label: 'Schweden', names: ['schweden', 'sweden', 'se'] },
  { code: 'fi', label: 'Finnland', names: ['finnland', 'finland', 'fi'] },
  { code: 'ie', label: 'Irland', names: ['irland', 'ireland', 'ie'] },
];

export function countryCode(name: string | null | undefined): string | null {
  const n = String(name ?? '').trim().toLowerCase();
  return COUNTRIES.find(c => c.names.includes(n))?.code ?? null;
}

export interface ShippingEstimate { cost: number; domestic: boolean; tracked: boolean; known: boolean }

/** Geschätztes Porto für eine Bestellung mit Warenwert `value` bei einem Verkäufer aus `country`. */
export function shippingCost(value: number, country: string | null | undefined, s: AppSettings['shipping']): ShippingEstimate {
  const code = countryCode(country);
  const domestic = code === s.homeCountry;
  const tracked = value >= s.trackedFrom;
  const cost = domestic ? (tracked ? s.domesticTracked : s.domestic) : (tracked ? s.intlTracked : s.intl);
  return { cost, domestic, tracked, known: code != null };
}
