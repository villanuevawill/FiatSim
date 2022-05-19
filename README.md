# FIAT Sim

## Setup Instructions

Install dependencies
```sh
npm install
```

Set .env
```sh
cat example.env > .env
# edit .env
```

## Run Simulation
Simulation project to see the interaction between Element, FIAT and Curve.

```sh
npx hardhat run scripts/simulate.js
```

matplot lib graphs and html tables are generated with:

```sh
python charts.py
```

See HTML files for generated graphs.

Some simple, generated graphs:

<img width="613" alt="image" src="https://user-images.githubusercontent.com/7415822/169176020-fcd361c5-3778-413e-9a0b-c6b191d3f9da.png">
<img width="611" alt="image" src="https://user-images.githubusercontent.com/7415822/169176036-00a94c08-25f4-454d-b801-8f4e82d47cba.png">
