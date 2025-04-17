# Fusebox Nodes for Node-RED

This repository contains various custom nodes to interface with Uniflex Systems (tailored for Fusebox) automation controllers, allowing for reading, writing, performing calculations, and other operations on the controller's data streams.

## Important Note

This node is still in beta and might include bugs. Any feedback is welcome.

## Features

-   Query data stream values from automation controllers
-   Save data stream values to automation controllers
-   Perform calculations on data stream values, incl. boolean operations
-   Support for multiple controllers

## Installation

You can install this node directly from the "Manage Palette" menu in the Node-RED interface.

Alternatively, run the following command in your Node-RED user director: `npm install @janart19/node-red-fusebox`

## Usage

-   In the Node-RED editor, open up the documentation sidebar and search for Fusebox nodes
-   Add an appropriate node to your flow, and open the node's configuration dialog
-   Configure or select a contoller settings node
-   Configure other node settings as required
-   Deploy the flow
