# Fusebox Nodes for Node-RED

This repository contains various custom nodes to interface with Uniflex Systems (tailored for Fusebox) automation controllers, allowing for reading, writing, performing calculations, and other operations on the controller's data streams.

## Features

- Query data stream values from automation controllers
- Save data stream values to automation controllers
- Perform calculations on data stream values, incl. boolean operations
- Support for multiple controllers

## Requirements

- Node-RED ≥ 4.0.0
- Node.js ≥ 16
- Access to a Fusebox automation controller (for controller-backed nodes)

## Important Note

This node is still in beta and might include bugs. Any feedback is welcome.

## Installation

You can install this node directly from the "Manage Palette" menu in the Node-RED interface.

Alternatively, run the following command in your Node-RED user director: `npm install @janart19/node-red-fusebox`

## Available nodes

### Core (`fusebox-core`)

| Type                                 | Role                         |
| ------------------------------------ | ---------------------------- |
| `fusebox-controller`                 | Controller configuration     |
| `fusebox-query-data-streams`         | Query real-time data streams |
| `fusebox-query-external-connections` | Query external connections   |
| `fusebox-read-data-streams`          | Read stream values           |
| `fusebox-write-data-streams`         | Write stream values          |
| `fusebox-sql-calendar`               | Calendar / scheduling        |
| `fusebox-security`                   | Auth / security              |

### Energy (`fusebox-energy`)

| Type                                   | Role                                    |
| -------------------------------------- | --------------------------------------- |
| `fusebox-inverter-control`             | Inverter power management               |
| `fusebox-inverter-control-dual-limits` | Dual-limits / grid-interactive inverter |

### Utils (`fusebox-utils`)

| Type                      | Role                    |
| ------------------------- | ----------------------- |
| `fusebox-averager`        | Value averaging         |
| `fusebox-averager-gated`  | Gated value averaging   |
| `fusebox-arithmetics`     | Arithmetic operations   |
| `fusebox-boolean-logic`   | Boolean logic           |
| `fusebox-comparator`      | Value comparison        |
| `fusebox-value-converter` | Value / unit conversion |
| `fusebox-flow-analyzer`   | Flow analysis           |
| `fusebox-flow-validator`  | Flow validation         |
| `fusebox-measure-delay`   | Delay measurement       |
| `fusebox-pid-controller`  | PID control             |
| `fusebox-clock-ticker`    | Automatic PWM trigger   |
| `fusebox-manual-ticker`   | Manual PWM trigger      |
| `fusebox-triple-status`   | Status display          |

## Documentation

Select a node in the editor and open the **info** sidebar for full help text.
