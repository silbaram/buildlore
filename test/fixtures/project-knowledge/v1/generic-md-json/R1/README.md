# Parcel

Parcel is a local batch-delivery planner for an operator working offline. It prepares delivery manifests; it does not send packages or contact carriers.

The documented processing path is CLI -> planner -> manifest store. Consult src/planner for grouping rules and src/store for manifest persistence. These locations are documented responsibilities, not evidence that the current code implements them.

Carrier booking is planned. Its implementation has not been evidenced.
