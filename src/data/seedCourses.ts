import { Course } from "./types";

/// Hard-coded placeholder courses so the UI has something to render before we
/// build the filesystem-backed course loader. Replace with real content once
/// the ingest pipeline lands.

export const seedCourses: Course[] = [
  {
    id: "js-first-steps",
    title: "JavaScript First Steps",
    author: "Kata Team",
    description: "A gentle intro to JavaScript. Variables, functions, and a little bit of DOM.",
    language: "javascript",
    chapters: [
      {
        id: "intro",
        title: "Introduction",
        lessons: [
          {
            id: "hello",
            kind: "reading",
            title: "What is JavaScript?",
            body: `# What is JavaScript?

JavaScript is the language of the web. It runs in every browser and, these days,
on your server too.

In this course we'll cover the fundamentals — the kind of things you reach for
every single day.

Here's a flavour of what code looks like:

\`\`\`javascript
function greet(name) {
  return \`Hello, \${name}!\`;
}
console.log(greet("world"));
\`\`\`
`,
          },
          {
            id: "first-exercise",
            kind: "exercise",
            title: "Your first function",
            language: "javascript",
            body: `# Your first function

Implement \`add\` so that \`add(2, 3)\` returns \`5\`.`,
            starter: `function add(a, b) {
  // your code here
}

console.log('add(2, 3) =', add(2, 3));
`,
            solution: `function add(a, b) {
  return a + b;
}

console.log('add(2, 3) =', add(2, 3));
`,
            tests: `const { add } = require("./user");
test("adds two numbers", () => {
  expect(add(2, 3)).toBe(5);
});
`,
          },
        ],
      },
    ],
  },

  {
    id: "rust-taste",
    title: "A Taste of Rust",
    author: "Kata Team",
    description: "Syntax and ownership concepts from the Rust Book, condensed.",
    language: "rust",
    chapters: [
      {
        id: "ownership",
        title: "Ownership",
        lessons: [
          {
            id: "ownership-reading",
            kind: "reading",
            title: "What is ownership?",
            body: `# What is ownership?

Ownership is Rust's memory-management model. Every value has a single owner.
When the owner goes out of scope, the value is dropped.

\`\`\`rust
fn main() {
    let s = String::from("hello");
    println!("{}", s);
} // s is dropped here
\`\`\`
`,
          },
        ],
      },
    ],
  },
];
