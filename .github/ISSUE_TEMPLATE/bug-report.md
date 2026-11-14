---
name: Bug report
description: Something in install / update / status misbehaves
labels: ["bug"]
body:
  - type: markdown
    attributes:
      value: |
        The [architecture doc](../../blob/master/docs/ARCHITECTURE.md)
        explains how the pieces fit; the [Trust model in the
        README](../../blob/master/README.md#trust-model) covers what the
        tools will and won't do by design.
  - type: dropdown
    id: command
    attributes:
      label: Which command?
      options:
        - ./install.sh install
        - ./install.sh update
        - ./install.sh status
        - something else (described below)
    validations:
      required: true
  - type: textarea
    id: what-happened
    attributes:
      label: What happened?
      description: What you saw, and what you expected instead. Paste full output — the scripts are designed to tell you what they did.
    validations:
      required: true
  - type: dropdown
    id: target
    attributes:
      label: Which target is affected?
      options:
        - pi
        - Mistral Vibe
        - Claude Code
        - more than one / not target-specific
    validations:
      required: true
  - type: input
    id: environment
    attributes:
      label: OS and Node version
      description: install.sh requires Node >= 18. `node -v` and your OS are enough.
      placeholder: "macOS 15, v26.10.0"
    validations:
      required: true
  - type: textarea
    id: status-output
    attributes:
      label: Output of ./install.sh status (optional)
      description: The read-only health table — most issues are visible in it at a glance.
      render: shell
  - type: checkboxes
    id: local-overlay
    attributes:
      label: Do you have a repos.local.json overlay?
      options:
        - label: "Yes — I have local-only entries in repos.local.json (this changes generation behavior)"
          required: false
---
