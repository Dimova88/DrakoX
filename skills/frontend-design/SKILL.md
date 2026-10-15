---
name: frontend-design
description: Build polished, accessible, responsive user interfaces with strong visual hierarchy. Use when creating or restyling web pages, components, dashboards or landing pages.
---

# Frontend design

## Before coding
- Identify the user's goal on the screen and the single primary action.
- Reuse the project's design system (Tailwind config, CSS variables, component library).
  Don't introduce a new UI library without asking.

## Visual quality checklist
- **Hierarchy**: one clear heading, readable body (14–16px, 1.5–1.7 line height), muted secondary text.
- **Spacing**: consistent scale (4/8px), generous whitespace, aligned edges.
- **Colour**: neutral base + one accent; meet WCAG AA contrast (4.5:1 text). Support dark mode if the project does.
- **States**: hover, focus-visible, active, disabled, loading (skeletons), empty and error states.
- **Motion**: subtle (150–250ms), respects `prefers-reduced-motion`.
- **Responsive**: mobile-first; test ~360px, 768px, 1280px widths; no horizontal scroll.

## Accessibility
Semantic HTML (button vs div), labels for inputs, alt text, keyboard navigation and focus
order, `aria-*` only when semantics are not enough.

## Verify
Run the dev server/build, check the console for errors, and describe how to view the result.
