// Echo's think_it_through tool: checks a decision the model brings, then turns it into the cards Echo draws.
// A decision is only as good as the options it names, so each one has to say what it gives and what it asks,
// the lean has to be one of them, and the reason has to stand on its own. Pure data in, cards out: no screen here.

export const THINK_MAX_OPTIONS = 5;
const clean = (s) => String(s ?? '').trim();
const fold = (s) => clean(s).toLowerCase();

/** Everything wrong with a decision, as lines the model can fix; [] when it is ready to draw. */
export function thinkProblems({ decision, options = [], values = [], lean, why, next } = {}) {
  const out = [];
  if (!clean(decision)) out.push('decision: needs the choice in a few words (it becomes the table\'s title).');
  else if (clean(decision).length > 60) out.push('decision: keep it under 60 characters (it becomes the table\'s title).');
  if (!Array.isArray(options) || options.length < 2) out.push('options: give 2 to 5 real options (what they are choosing between).');
  else {
    if (options.length > THINK_MAX_OPTIONS) out.push(`options: at most ${THINK_MAX_OPTIONS}.`);
    const seen = new Set();
    options.forEach((o, i) => {
      const name = clean(o?.name), who = `option ${i + 1}${name ? ` (${name})` : ''}`;
      if (!name) out.push(`${who}: needs a name.`);
      else if (name.length > 40) out.push(`${who}: name under 40 characters.`);
      else if (seen.has(fold(name))) out.push(`${who}: "${name}" is listed twice; give each option its own name.`);
      if (name) seen.add(fold(name));
      // A trade-off has two sides: what it gives and what it asks. One alone is a pitch, not thinking.
      if (!clean(o?.good) && !clean(o?.bad)) out.push(`${who}: give good, bad, or both (what it gives and what it asks).`);
      if (clean(o?.good).length > 80) out.push(`${who}: good under 80 characters.`);
      if (clean(o?.bad).length > 80) out.push(`${who}: bad under 80 characters.`);
    });
  }
  const vals = Array.isArray(values) ? values : [];
  if (vals.length > 4) out.push('values: at most 4 (what matters most).');
  vals.forEach((v, i) => {
    if (!clean(v)) out.push(`value ${i + 1}: is empty.`);
    else if (clean(v).length > 60) out.push(`value ${i + 1}: under 60 characters.`);
  });
  const opts = Array.isArray(options) ? options : [];
  const names = opts.map((o) => fold(o?.name));
  if (!clean(lean)) out.push('lean: name the option you lean toward (one of the options, word for word).');
  else if (!names.includes(fold(lean))) out.push(`lean: "${lean}" is not one of the options${names.length ? ` (${opts.map((o) => `"${clean(o?.name)}"`).join(', ')})` : ''}. Pick one of them, word for word.`);
  if (!clean(why)) out.push('why: a sentence or two on why that option fits what matters.');
  else if (clean(why).length > 240) out.push('why: under 240 characters.');
  if (clean(next).length > 140) out.push('next: under 140 characters.');
  return out;
}

/** The beats think_it_through draws: what matters, the options side by side, then Echo's lean and why.
 *  The quote is a recommendation, not a verdict: it says "I'd lean", so the user keeps the last word. */
export function thinkBeats({ decision, options = [], values = [], lean, why, next } = {}, author = 'Echo') {
  const d = clean(decision), whyText = clean(why), step = clean(next);
  const opts = Array.isArray(options) ? options : [];
  // The option's own spelling, whatever case the lean came in as ("stay" → "Stay").
  const pick = clean(opts.find((o) => fold(o?.name) === fold(lean))?.name ?? lean);
  const matters = (Array.isArray(values) ? values : []).map(clean).filter(Boolean);
  const beats = [];
  if (matters.length) beats.push({
    say: 'First, what matters most.',
    marks: [{ kind: 'list', title: 'what matters most', items: matters }],
  });
  beats.push({
    say: 'Now the options, side by side.',
    marks: [{
      kind: 'table', title: d, columns: ['option', 'what it gives', 'what it asks'],
      rows: opts.map((o) => [clean(o?.name), clean(o?.good) || '—', clean(o?.bad) || '—']),
    }],
  });
  beats.push({
    say: `I'd lean toward ${pick}.`,
    marks: [{
      kind: 'quote',
      text: `I'd lean toward ${pick}. ${whyText}${step ? ` First step: ${step}.` : ''}`,
      author: clean(author) || 'Echo',
    }],
  });
  return beats;
}
