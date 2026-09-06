# Parcel responsibilities

The CLI reads the selected input list and validates options. The planner groups deliveries by region. The store saves a reviewable manifest. A store failure must leave the prior manifest intact.

The planning input is local JSON. A network connector is explicitly outside the project scope.
