import json, random, string

from fastapi import APIRouter
from fastapi.requests import Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates

from app.models import DataIn
from app.settings import APP_ID, REDIS_CHANNEL, redis
from app.utils import make_client_id, make_return_txt, write_to_log
from app.wsmanager import wsmanager


router = APIRouter()
templates = Jinja2Templates(directory="app/templates")


@router.get("/", response_class=HTMLResponse)
async def homepage(request: Request):
    """
    Websocket connection begins **after** index.html in returned
    APP_ID 1 responding to client_id X doesn't guarantee X's websocket conn will be with APP_1
    """
    client_id = await make_client_id()
    stickycookie = ''.join(random.choices(string.ascii_lowercase, k=8))
    response = templates.TemplateResponse(
        request=request, name="index.html",
        context={'session_id': client_id, "sticky_str": f"{stickycookie}-by-{APP_ID}", "page_by": APP_ID}
    )
    response.set_cookie("StickyStr", f"{stickycookie}-by-{APP_ID}")
    return response


@router.get("/readme", response_class=HTMLResponse)
async def readme(request: Request):
    """
    Display the contents of the README.md in markdown format
    """
    return templates.TemplateResponse(
        request=request, name="readme.html"
    )


@router.post("/submit/{client_id}")
async def http_echo(input: DataIn, client_id: str, request: Request):
    """
    Echoes back whatever text the user sends with http with http
    """
    write_to_log("http-echo", client_id, input.text)

    print(request.cookies)

    return {'text': make_return_txt(input)}


@router.post("/without-redis/{client_id}")
async def via_ws(input: DataIn, client_id: str):
    """
    HTTP connections are ephemereal, stateless
    Any http request from user are not necessarily received by the worker that has the ws-connection
    """
    write_to_log("http-ws", client_id, input.text)

    text = make_return_txt(input)
    has_connection = await wsmanager.send_message(client_id, text)

    if has_connection:
        return {'text': f"[{APP_ID}] replying with ws"}
    else:
        return {'text': f"[{APP_ID}] no connection to {client_id}"}


@router.post("/with-redis/{client_id}")
async def send_message(input: DataIn, client_id: str):
    """
    Publish messages to redis queue and any worker that has the ws-connection can respond
    """
    write_to_log("http-redis", client_id, input.text)

    input_dict = input.model_dump()
    input_dict['pid'] = APP_ID
    input_dict['client_id'] = client_id

    input_json = json.dumps(input_dict)

    await redis.publish(REDIS_CHANNEL, input_json)
    return {'text': f"[{APP_ID}] publishing to redis"}
