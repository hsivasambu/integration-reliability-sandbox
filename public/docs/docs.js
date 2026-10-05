// Renders /openapi.yaml with Swagger UI. Kept in a file (not inline) because the CSP allows only
// same-origin scripts.
window.SwaggerUIBundle({
  url: '/openapi.yaml',
  dom_id: '#swagger-ui',
  deepLinking: true,
  // No call to the public validator service: the page talks to this origin only.
  validatorUrl: null,
  // "Try it out" needs a demo token (Authorize). Internal routes will answer 401 by design.
  tryItOutEnabled: false,
  persistAuthorization: false,
});
