/**
 * Popup-Test für den Decklisten-Import (nur aktiv bei popup.test.html#import):
 * füllt das Textfeld, klickt "Zur Watchlist hinzufügen" und lässt das Ergebnis sichtbar.
 */
(function () {
  if (location.hash !== '#import') return;
  setTimeout(() => {
    document.querySelector('details.import').open = true;
    document.getElementById('decklist').value = [
      'Deck',
      '4 Lightning Bolt',          // existiert schon mit 4 → bleibt 4
      '2x Counterspell (MH2) 267', // existiert schon
      '4 Ragavan, Nimble Pilferer',
      '1 Delver of Secrets // Insectile Aberration',
      'SB: 2 Pyroblast'
    ].join('\n');
    document.getElementById('importBtn').click();
  }, 300);
})();
