# Module Development Folder

This folder is for developing App Store modules with full TypeScript support.

## Usage

Clone or create your App Store repository inside this folder:

```bash
cd src/bot/modulesDev
git clone https://github.com/your-username/your-appstore-repo.git
```

The bot will automatically discover and load modules from any `Modules/` subfolder here.

## Structure

```
modulesDev/
├── README.md                    ← This file (tracked)
└── your-appstore-repo/          ← Your App Store git repo (gitignored)
    └── Modules/
        ├── your-module/
        │   ├── module.json
        │   └── commands/
        └── another-module/
```

## Benefits

- Full TypeScript type support during development
- Hot-reload with `npm run dev`
- Separate git repository for your App Store
- Main bot repo stays clean (this folder is gitignored)

## Notes

- Everything in this folder is gitignored EXCEPT this README
- Each App Store repo should have its own `.git` folder
- Modules here load alongside regular `modules/` folder
