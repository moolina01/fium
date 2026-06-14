Son tres llamadas en secuencia: auth → quote → create delivery. Te las dejo con formato Chile listas para copiar.
Base URL: https://api.uber.com/v1/customers/{customer_id}/

1. Obtener token (OAuth)
bashcurl -X POST 'https://auth.uber.com/oauth/v2/token' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'client_id=TU_CLIENT_ID' \
  -d 'client_secret=TU_CLIENT_SECRET' \
  -d 'grant_type=client_credentials' \
  -d 'scope=eats.deliveries'
Respuesta:
json{
  "access_token": "TOKEN...",
  "expires_in": 2592000,
  "token_type": "Bearer",
  "scope": "eats.deliveries"
}
El token dura 30 días. Guárdalo y renuévalo antes de que expire.

2. Cotizar (Quote)
POST https://api.uber.com/v1/customers/{customer_id}/delivery_quotes
bashcurl -X POST 'https://api.uber.com/v1/customers/TU_CUSTOMER_ID/delivery_quotes' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer TOKEN' \
  -d '{
    "pickup_address": "{\"street_address\":[\"Av Providencia 1234\"],\"city\":\"Santiago\",\"state\":\"Región Metropolitana\",\"zip_code\":\"7500000\",\"country\":\"CL\"}",
    "dropoff_address": "{\"street_address\":[\"Av Las Condes 9000\"],\"city\":\"Santiago\",\"state\":\"Región Metropolitana\",\"zip_code\":\"7550000\",\"country\":\"CL\"}"
  }'
Ojo clave: pickup_address y dropoff_address son strings JSON dentro de un JSON (un string que contiene un JSON escapado, no un objeto). Eso confunde a todo el mundo la primera vez.
Respuesta:
json{
  "kind": "delivery_quote",
  "id": "dqt_ABC123...",
  "fee": 3990,
  "currency": "clp",
  "duration": 35,
  "pickup_duration": 15,
  "dropoff_eta": "2026-06-01T15:30:00Z",
  "expires": "2026-06-01T15:15:00Z"
}
Guarda el id — es el quote_id que necesitas para crear el delivery. El quote expira en 15 minutos.

3. Crear Delivery
POST https://api.uber.com/v1/customers/{customer_id}/deliveries
bashcurl -X POST 'https://api.uber.com/v1/customers/TU_CUSTOMER_ID/deliveries' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer TOKEN' \
  -d '{
    "quote_id": "dqt_ABC123...",
    "pickup_address": "{\"street_address\":[\"Av Providencia 1234\"],\"city\":\"Santiago\",\"state\":\"Región Metropolitana\",\"zip_code\":\"7500000\",\"country\":\"CL\"}",
    "pickup_name": "Mi Tienda",
    "pickup_phone_number": "+56911111111",
    "pickup_latitude": -33.4265,
    "pickup_longitude": -70.6145,
    "dropoff_address": "{\"street_address\":[\"Av Las Condes 9000\"],\"city\":\"Santiago\",\"state\":\"Región Metropolitana\",\"zip_code\":\"7550000\",\"country\":\"CL\"}",
    "dropoff_name": "Juan Pérez",
    "dropoff_phone_number": "+56922222222",
    "dropoff_latitude": -33.4050,
    "dropoff_longitude": -70.5720,
    "manifest_items": [
      {
        "name": "Polera negra talla M",
        "quantity": 1,
        "weight": 300,
        "dimensions": {
          "length": 30,
          "height": 10,
          "depth": 25
        }
      }
    ]
  }'
Respuesta (lo relevante):
json{
  "id": "del_XYZ789...",
  "status": "pending",
  "fee": 3990,
  "currency": "clp",
  "tracking_url": "https://www.ubereats.com/orders/...",
  "pickup_eta": "2026-06-01T15:10:00Z",
  "dropoff_eta": "2026-06-01T15:35:00Z",
  "courier": null,
  "live_mode": false
}
El tracking_url es el que le muestras al cliente para que siga su pedido. El status va cambiando: pending → pickup → pickup_complete → dropoff → delivered. Esos cambios te llegan por webhook si lo configuras, o puedes consultarlos con GET al delivery.
