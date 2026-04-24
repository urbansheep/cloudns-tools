# Template Catalog

`docs/examples/` contains the rich source-of-truth template catalog gathered from provider documentation.

Use it for:

- provider references
- update provenance
- manual lookup instructions
- placeholders and agent notes
- template review before promoting changes

Do not treat every file in this catalog as directly runnable by the CLI.

`templates/` remains the runtime-safe preset directory. Files there must contain only concrete records that can be applied automatically without manual lookup or placeholder substitution.
