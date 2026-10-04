# Attributions

skill-router generates agents from third-party skills repositories. This
repository itself **contains and redistributes no third-party skill
content** — each repo is cloned at install time (with its own LICENSE
file intact) for the operator's private use, and the generated agent
definitions reference skills by name and local path only.

These projects are the entire reason this tool exists. If you use the
generated personas, check out the upstream repos directly:

| Manifest entry | Upstream repository | License |
|---|---|---|
| `ponytail` | [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) | MIT |
| `mattpocock` | [mattpocock/skills](https://github.com/mattpocock/skills) | MIT |
| `i-have-adhd` | [ayghri/i-have-adhd](https://github.com/ayghri/i-have-adhd) | MIT |
| `security-audit` | [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill) | MIT |
| `superpowers` | [obra/superpowers](https://github.com/obra/superpowers) | MIT |
| `diagram-design` | [cathrynlavery/diagram-design](https://github.com/cathrynlavery/diagram-design) | MIT |
| `humanizer` | [blader/humanizer](https://github.com/blader/humanizer) | MIT |
| `graphify` | [Graphify-Labs/graphify](https://github.com/Graphify-Labs/graphify) | Apache-2.0 (also offers MIT) |
| `addyosmani` | [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) | MIT |
| `impeccable` | [pbakaus/impeccable](https://github.com/pbakaus/impeccable) | Apache-2.0 |

Licenses were verified against the `LICENSE` files present in each clone
(2026-10-04). Re-verify with `./install.sh update` if you add or swap
repos. All current dependencies are permissive (MIT / Apache-2.0); none
are copyleft. If a future manifest entry brings a copyleft or unlicensed
repo, stop and read its terms before installing — an entry with **no
license file** means default copyright: fine to clone for personal use,
but do not redistribute its content.

If you distribute skill-router itself, note that it does not convey any
rights to the upstream skill content; each upstream license governs that
material.
