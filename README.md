<div align="center">

# pi-clinepass

**ClinePass provider for [pi](https://pi.dev) coding agent**

Dollar-based limits, live cost tracking, and plan cap reporting.

<br>

<p align="center">
  <a href="https://www.npmjs.com/package/pi-clinepass"><img src="https://img.shields.io/badge/npm-pi--clinepass-CB3837?style=for-the-badge&logo=npm&logoColor=white" alt="npm package"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-7.0-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript 7"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D22.19-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-000000?style=for-the-badge" alt="MIT License"></a>
</p>

<br>

<img src="https://raw.githubusercontent.com/fifidayone/pi-clinepass/main/assets/status.png" alt="pi-clinepass status meter" width="680">

</div>

<br>

## Highlights

- **16 Models**: 13 ClinePass models on a dollar-based limit system plus 3 free tier models
- **Live Status Meter**: Per-turn and session cost directly in the pi footer
- **Plan Utilization**: 5-hour, weekly, and monthly caps tracked via `/clinepass`
- **Simple Auth**: One-time login via Cline CLI, browser, or API key

---

## Installation

Requires **Node.js 22.19+** and [pi](https://pi.dev).

```sh
pi install npm:pi-clinepass
```

---

## Quickstart

### 1. Authenticate

Run the login command inside pi:

```
/login
```

Select **ClinePass** to choose your sign-in method:

<br>

<div align="center">
  <img src="https://raw.githubusercontent.com/fifidayone/pi-clinepass/main/assets/login.png" alt="ClinePass login menu" width="620">
</div>

<br>

- **Use existing sign-in (Cline CLI)**: keep using your Cline CLI account
- **Sign in with browser**: log in once in your browser
- **Enter API key**: paste your ClinePass key

### 2. Select a Model

Pick any model using the interactive selector:

```
/model
```

---

## Report

View the live rate sheet and plan limit utilization anytime:

```
/clinepass
```

<div align="center">
  <img src="https://raw.githubusercontent.com/fifidayone/pi-clinepass/main/assets/report.png" alt="ClinePass report with pricing and plan limits" width="620">
</div>

---

## Development

```sh
git clone https://github.com/fifidayone/pi-clinepass.git
cd pi-clinepass
npm install
npm test
npm run typecheck
```

---

## Support

pi-clinepass is free and will stay free. If you'd like to help, consider buying me a coffee:

<p align="left">
  <a href="https://www.paypal.com/paypalme/fifidayone"><img src="https://img.shields.io/badge/PayPal-fifidayone-00457C?style=for-the-badge&logo=paypal&logoColor=white" alt="Support via PayPal"></a>
</p>

---

## License

[MIT](LICENSE) © 2026 fifidayone
