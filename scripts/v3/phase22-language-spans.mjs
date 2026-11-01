/** Flatten an accepted language view into ordered section/paragraph span rows. */
export function collectLanguageSpans(view) {
  return view.sections.flatMap(section=>section.paragraphs.flatMap(paragraph=>paragraph.spans.map(span=>({section_id:section.section_id,paragraph_id:paragraph.paragraph_id,span}))));
}
