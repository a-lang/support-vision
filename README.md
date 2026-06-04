# Agent Skills by penfick

A collection of Agent Skills for Claude Code / Codex / Pi Agent / any tool supporting the [Agent Skills](https://agentskills.io) standard.

## Skills

| Skill | Description |
|-------|-------------|
| [vision-support](./vision-support/) | Image recognition for non-multimodal AI models. Multi-image support, 19+ platforms, auto-fallback. |

## Install

### `npx skills` (Recommended)

```bash
# Install a specific skill
npx skills add https://github.com/penfick/skills --skill vision-support -g -y

# List all available skills
npx skills add https://github.com/penfick/skills --list
```

### Git Clone

```bash
git clone https://github.com/penfick/skills.git ~/.agents/skills
```

## Structure

```
skills/
├── README.md
├── LICENSE
└── vision-support/
    ├── SKILL.md
    └── ...
```

Each subdirectory is an independent skill containing a `SKILL.md` file, compliant with the [Agent Skills specification](https://agentskills.io/specification).

## 🤝 Sponsorship & Support

This project is independently developed and maintained by **penfick**. 
For open-source sponsorships, API grant verifications, or general inquiries, please contact: **xingf6066@gmail.com**

## Friends

 [LinuxDo](https://linux.do) 

## License

MIT
