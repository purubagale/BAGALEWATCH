// nt-frontend skill trial (2026-09-29) -- only src/styleTest/tailwind.css
// runs through this; every other .css file in the app (App.css) is
// plain CSS with no Tailwind directives at all, so this pipeline is a
// no-op for them either way.
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
