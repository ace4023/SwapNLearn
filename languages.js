// Single source of truth for profile skills. Loaded by the browser AND by server.js.
const LANGUAGES = [
  'Python', 'JavaScript', 'TypeScript', 'Java', 'C', 'C++', 'C#', 'Go', 'Rust', 'Kotlin', 'Swift',
  'PHP', 'Ruby', 'Dart', 'Scala', 'R', 'MATLAB', 'Julia', 'Perl', 'Lua', 'Haskell', 'Elixir',
  'Erlang', 'Clojure', 'F#', 'OCaml', 'Objective-C', 'Groovy', 'Shell/Bash', 'PowerShell', 'SQL',
  'Assembly', 'COBOL', 'Fortran', 'Pascal', 'Visual Basic', 'Lisp', 'Scheme', 'Prolog', 'Solidity',
  'Zig', 'Nim', 'Crystal', 'Elm'
];
const LEVELS = ['Beginner', 'Intermediate', 'Advanced', 'Expert'];
if (typeof module !== 'undefined') module.exports = { LANGUAGES, LEVELS };
