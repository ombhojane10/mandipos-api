import { sayRows } from '../src/voice/portal-voice.service';

// Bolo's spoken line for a query answer: short, named figures, never a run of bare cells.
describe('sayRows', () => {
  it('reads a few named rows as one clause each, in boxes', () => {
    const rows = [
      { bhugtan: 'Cash', parchiyan: 2, box: 10, rakam: 6464, cash: 6464, upi: 0 },
      { bhugtan: 'Udhaar', parchiyan: 26, box: 817, rakam: 174342.8, cash: 0, upi: 0 },
      { bhugtan: 'UPI', parchiyan: 2, box: 41, rakam: 19523.3, cash: 0, upi: 19523.3 },
    ];
    expect(sayRows('Aaj ka hisab', ['bhugtan', 'parchiyan', 'box', 'rakam', 'cash', 'upi'], rows, 'box'))
      .toBe('Cash — 2 parchi, 10 box, ₹6,464. Udhaar — 26 parchi, 817 box, ₹1,74,343. UPI — 2 parchi, 41 box, ₹19,523');
  });

  it('sums a long list instead of reading it out', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ parchi_no: String(30 - i), grahak: `G${i}`, box: 10, rakam: 1000, bhugtan: 'Udhaar' }));
    expect(sayRows('Aaj ki bikri', ['parchi_no', 'grahak', 'box', 'rakam', 'bhugtan'], rows, 'box'))
      .toBe('Aaj ki bikri: 30 parchi · 300 box · ₹30,000. Poori list neeche.');
  });

  it('names the figures of one row and leaves out ₹0', () => {
    expect(sayRows('Santosh ko kitna gaya', ['parchiyan', 'total_box', 'total_rakam', 'baaki'], [{ parchiyan: 4, total_box: 60, total_rakam: 12000, baaki: 0 }], 'box'))
      .toBe('Santosh ko kitna gaya: 4 parchi, 60 box, ₹12,000');
  });
});
