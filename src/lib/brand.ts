/**
 * Brand action color — PipelineSync navy.
 *
 * Intentionally a constant, not a semantic token: the primary clock actions
 * (Clock In, Clock Out, Switch client) must always read as *the* brand
 * action, including under seasonal skins. The Christmas theme re-points the
 * semantic tokens (see `.christmas` in src/index.css), which would turn these
 * buttons red — the navy is what separates "this is the money button" from
 * everything else on the screen. Dark mode inverts to white-on-navy text.
 */
export const BRAND_ACTION_BUTTON =
  'bg-[#06245B] hover:bg-[#0a306e] dark:bg-white dark:text-[#06245B] dark:hover:bg-white/90'
