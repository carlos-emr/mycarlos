// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::{borrow::Cow, sync::Arc};

use http::{header::CONTENT_TYPE, Request, Response as HttpResponse, StatusCode};
use tauri_utils::config::HeaderAddition;

use crate::{
  manager::{webview::PROXY_DEV_SERVER, AppManager},
  webview::{UriSchemeProtocolHandler, WebResourceRequestHandler},
  Runtime,
};

// myCarlos packages local assets on mobile and does not use the network proxy.
// Fail explicitly instead of silently changing the behaviour of mobile `dev`.
#[cfg(all(dev, mobile))]
compile_error!("myCarlos disables Tauri's mobile development-server proxy; use `tauri android build --debug` or `tauri ios build --debug` with bundled assets");

pub fn get<R: Runtime>(
  manager: Arc<AppManager<R>>,
  window_origin: String,
  web_resource_request_handler: Option<Box<WebResourceRequestHandler>>,
) -> UriSchemeProtocolHandler {
  let context = Arc::new(Context {
    manager,
    web_resource_request_handler,
    window_origin,
  });

  Box::new(move |_, request, responder| {
    let context = context.clone();
    crate::async_runtime::spawn(async move {
      match get_response(&context, request).await {
        Ok(response) => responder.respond(response),
        Err(e) => responder.respond(
          HttpResponse::builder()
            .status(StatusCode::INTERNAL_SERVER_ERROR)
            .header(CONTENT_TYPE, mime::TEXT_PLAIN.essence_str())
            .header("Access-Control-Allow-Origin", &context.window_origin)
            .body(e.to_string().into_bytes())
            .unwrap(),
        ),
      }
    });
  })
}

struct Context<R: Runtime> {
  manager: Arc<AppManager<R>>,
  window_origin: String,
  web_resource_request_handler: Option<Box<WebResourceRequestHandler>>,
}

async fn get_response<R: Runtime>(
  context: &Context<R>,
  request: Request<Vec<u8>>,
) -> Result<HttpResponse<Cow<'static, [u8]>>, Box<dyn std::error::Error>> {
  let Context {
    manager,
    web_resource_request_handler,
    window_origin,
  } = context;

  // use the entire URI as we are going to proxy the request
  let path = if PROXY_DEV_SERVER {
    request.uri().to_string()
  } else {
    // ignore query string and fragment
    request
      .uri()
      .to_string()
      .split(&['?', '#'])
      .next()
      .unwrap()
      .into()
  };

  let path = path
    .strip_prefix("tauri://localhost")
    .map(|p| p.to_string())
    // the `strip_prefix` only returns None when a request is made to `https://tauri.$P` on Windows and Android
    // where `$P` is not `localhost/*`
    .unwrap_or_default();

  let mut builder = HttpResponse::builder()
    .add_configured_headers(manager.config.app.security.headers.as_ref())
    .header("Access-Control-Allow-Origin", window_origin);

  let mut response = {
    let asset = manager.get_asset(
      path,
      request.uri().scheme() == Some(&http::uri::Scheme::HTTPS),
    )?;
    builder = builder.header(CONTENT_TYPE, &asset.mime_type);
    if let Some(csp) = &asset.csp_header {
      builder = builder.header("Content-Security-Policy", csp);
    }
    builder.body(asset.bytes.into())?
  };

  if let Some(handler) = web_resource_request_handler {
    handler(request, &mut response);
  }

  Ok(response)
}
