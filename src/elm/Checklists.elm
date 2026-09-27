port module Checklists exposing (main)

{-| Checklists and their runs. The list shows today's checklist first, then every
checklist in the folder and the latest runs. A run shows the note with a tick box
per item; finishing it asks whether the checklist itself should change.

The notes are never written: runs are kept by the host.

-}

import Browser
import Dict
import Gtd.Checklist as Checklist exposing (MarkState(..), Run)
import Gtd.Command.Checklists as Command exposing (Command)
import Gtd.Host as Host exposing (Requests)
import Gtd.Ui as Ui
import Html exposing (Html, button, div, h2, h3, header, li, p, section, span, strong, text, ul)
import Html.Attributes exposing (class, style)
import Html.Events exposing (onClick)
import Json.Decode as Decode exposing (Decoder)
import Json.Encode as Encode


port checklistsToHost : Encode.Value -> Cmd msg


port checklistsFromHost : (Decode.Value -> msg) -> Sub msg



-- STATE FROM THE HOST


type alias Summary =
    { path : String
    , title : String
    , itemCount : Int
    , lastFinished : String
    , openRunId : Maybe String
    }


type alias Recent =
    { id : String
    , title : String
    , day : String
    , done : Int
    , skipped : Int
    , open : Int
    }


type alias State =
    { directory : String
    , daily : String
    , dailyDone : Bool
    , today : String
    , shortLimit : Int
    , checklists : List Summary
    , recent : List Recent
    , run : Maybe Run
    }



-- MODEL


type alias Model =
    { state : State
    , requests : Requests ()
    , error : Maybe String
    }


type Msg
    = GotHost Decode.Value
    | Mark String String MarkState
    | Send Command


main : Program Decode.Value Model Msg
main =
    Browser.element
        { init = init
        , update = update
        , subscriptions = \_ -> checklistsFromHost GotHost
        , view = view
        }


init : Decode.Value -> ( Model, Cmd Msg )
init flags =
    case Decode.decodeValue stateDecoder flags of
        Ok state ->
            ( { state = state, requests = Host.noRequests, error = Nothing }, Cmd.none )

        Err error ->
            ( { state = emptyState, requests = Host.noRequests, error = Just (Decode.errorToString error) }, Cmd.none )


emptyState : State
emptyState =
    { directory = "", daily = "", dailyDone = False, today = "", shortLimit = 9, checklists = [], recent = [], run = Nothing }



-- UPDATE


update : Msg -> Model -> ( Model, Cmd Msg )
update msg model =
    case msg of
        GotHost value ->
            receiveHost value model

        Mark runId key state ->
            let
                -- Shown at once; the host's next state confirms it.
                marked =
                    Maybe.map
                        (\run ->
                            if run.id == runId then
                                { run | marks = Dict.insert key state run.marks }

                            else
                                run
                        )
                        model.state.run

                current =
                    model.state
            in
            send (Command.MarkItem { runId = runId, key = key, state = state }) { model | state = { current | run = marked } }

        Send command ->
            send command model


send : Command -> Model -> ( Model, Cmd Msg )
send command model =
    let
        ( requestId, requests ) =
            Host.issue () model.requests
    in
    ( { model | requests = requests, error = Nothing }, checklistsToHost (Host.envelope requestId (Command.encode command)) )


type HostEvent
    = StateEvent State
    | Replied Host.Outcome


receiveHost : Decode.Value -> Model -> ( Model, Cmd Msg )
receiveHost value model =
    case Decode.decodeValue hostEventDecoder value of
        Ok (StateEvent state) ->
            ( { model | state = state }, Cmd.none )

        Ok (Replied outcome) ->
            let
                ( _, requests ) =
                    Host.resolve outcome.requestId model.requests
            in
            case outcome.result of
                Err message ->
                    ( { model | requests = requests, error = Just message }, Cmd.none )

                Ok _ ->
                    ( { model | requests = requests }, Cmd.none )

        Err error ->
            ( { model | error = Just (Decode.errorToString error) }, Cmd.none )



-- VIEW


view : Model -> Html Msg
view model =
    div [ class "dg-view dg-checklists-view" ]
        [ header [ class "dg-view-header" ]
            [ div [] [ h2 [] [ text "Checklists" ] ] ]
        , Ui.maybeView model.error (\message -> div [ class "dg-panel dg-error" ] [ text message ])
        , div [ class "dg-checklists-body" ]
            [ case model.state.run of
                Just run ->
                    if run.finished then
                        finishedView model run

                    else
                        runView model run

                Nothing ->
                    listView model
            ]
        ]


listView : Model -> Html Msg
listView model =
    let
        state =
            model.state

        daily =
            List.filter (\summary -> summary.path == state.daily) state.checklists |> List.head
    in
    div []
        [ Ui.maybeView daily (todayView state)
        , section [ class "dg-checklists-section" ]
            [ h3 [] [ text "All checklists" ]
            , if List.isEmpty state.checklists then
                p [ class "dg-muted" ]
                    [ text
                        ("No checklists in “"
                            ++ state.directory
                            ++ "” yet. Every note in that folder is a checklist, and its task lines (- [ ]) are the items."
                        )
                    ]

              else
                ul [ class "dg-checklists-list" ] (List.map (summaryView state) state.checklists)
            ]
        , if List.isEmpty state.recent then
            text ""

          else
            section [ class "dg-checklists-section" ]
                [ h3 [] [ text "Recent runs" ]
                , ul [ class "dg-checklists-list" ] (List.map (recentView state) state.recent)
                ]
        ]


todayView : State -> Summary -> Html Msg
todayView state summary =
    section [ class "dg-checklist-card dg-checklists-today" ]
        [ span [ class "dg-checklist-label" ] [ text "Today" ]
        , h3 [] [ text summary.title ]
        , p []
            [ text
                (if state.dailyDone then
                    "✓ Done today."

                 else if summary.openRunId /= Nothing then
                    "Under way."

                 else
                    "Not done yet today."
                )
            ]
        , div [ class "dg-checklist-controls" ]
            [ if state.dailyDone then
                button [ onClick (Send (Command.StartRun summary.path)) ] [ text "Run again" ]

              else
                button [ class "mod-cta", onClick (Send (Command.StartRun summary.path)) ] [ text (startLabel summary) ]
            , button [ onClick (Send (Command.StartPomodoro summary.path)) ] [ text "Pomodoro" ]
            ]
        ]


summaryView : State -> Summary -> Html Msg
summaryView state summary =
    li [ class "dg-checklists-row" ]
        [ div [ class "dg-checklists-row-main" ]
            [ strong [] [ text summary.title ]
            , span [ class "dg-checklists-row-meta" ]
                (List.concat
                    [ [ span [] [ text (Ui.plural summary.itemCount "item") ] ]
                    , if summary.itemCount > state.shortLimit then
                        [ span [ class "dg-checklist-long" ] [ text "long: likely to be skimmed" ] ]

                      else
                        []
                    , if summary.path == state.daily then
                        [ span [] [ text "daily" ] ]

                      else
                        []
                    , [ span []
                            [ text
                                (if summary.openRunId /= Nothing then
                                    "under way"

                                 else if String.isEmpty summary.lastFinished then
                                    "never run"

                                 else
                                    "last done " ++ dayLabel state summary.lastFinished
                                )
                            ]
                      ]
                    ]
                )
            ]
        , button [ class "dg-flat-button dg-checklists-row-action", onClick (Send (Command.OpenNote summary.path)) ]
            (Ui.iconLabel "Edit" ("Edit the note " ++ summary.title))
        , button [ onClick (Send (Command.StartRun summary.path)) ] [ text (startLabel summary) ]
        ]


recentView : State -> Recent -> Html Msg
recentView state recent =
    li [ class "dg-checklists-row" ]
        [ div [ class "dg-checklists-row-main" ]
            [ button [ class "dg-flat-button dg-checklists-row-title", onClick (Send (Command.ShowRun (Just recent.id))) ]
                [ text recent.title ]
            , span [ class "dg-checklists-row-meta" ]
                [ span [] [ text (dayLabel state recent.day) ]
                , span [] [ text (countsText { done = recent.done, skipped = recent.skipped, open = recent.open }) ]
                ]
            ]
        ]


startLabel : Summary -> String
startLabel summary =
    if summary.openRunId /= Nothing then
        "Continue"

    else
        "Start"


runView : Model -> Run -> Html Msg
runView model run =
    let
        total =
            Checklist.itemCount run

        tally =
            Checklist.counts run

        progress =
            if total == 0 then
                0

            else
                toFloat (tally.done + tally.skipped) / toFloat total * 100
    in
    section [ class "dg-checklist-card dg-checklist-run" ]
        [ backButton
        , h3 [] [ text run.title ]
        , p [ class "dg-checklist-meta" ]
            [ text
                ("Started "
                    ++ (if run.startedDay == model.state.today then
                            run.startedTime

                        else
                            run.startedDay ++ " " ++ run.startedTime
                       )
                    ++ " · "
                    ++ String.fromInt tally.done
                    ++ " of "
                    ++ String.fromInt total
                    ++ " done"
                    ++ (if tally.skipped > 0 then
                            ", " ++ String.fromInt tally.skipped ++ " skipped"

                        else
                            ""
                       )
                )
            ]
        , div [ class "dg-progress-track" ] [ span [ style "width" (String.fromFloat progress ++ "%") ] [] ]
        , if run.noteMissing then
            p [ class "dg-checklist-warning" ] [ text "⚠ The note is gone; these are the items it had when the run began." ]

          else
            text ""
        , if total > model.state.shortLimit then
            p [ class "dg-checklist-hint" ]
                [ text
                    ("This checklist has "
                        ++ String.fromInt total
                        ++ " items. Long checklists get skimmed: keep the steps that are easy to miss and that matter, and move the rest to a linked note."
                    )
                ]

          else
            text ""
        , Checklist.itemsView
            { mark = Mark run.id
            , capture = Just (\itemText -> Send (Command.Capture { path = run.path, text = itemText }))
            , readOnly = False
            }
            run
        , div [ class "dg-checklist-controls" ]
            [ button [ class "mod-cta", onClick (Send (Command.FinishRun run.id)) ] [ text "Finish run" ]
            , button [ onClick (Send (Command.StartPomodoro run.path)) ] [ text "Pomodoro" ]
            , if run.noteMissing then
                text ""

              else
                button [ onClick (Send (Command.OpenNote run.path)) ] [ text "Edit checklist" ]
            , button [ class "mod-warning", onClick (Send (Command.DiscardRun run.id)) ] [ text "Discard" ]
            ]
        ]


{-| A finished run, and the question that keeps a checklist short and current.
-}
finishedView : Model -> Run -> Html Msg
finishedView model run =
    let
        textOf key =
            run.blocks
                |> List.filterMap
                    (\block ->
                        case block of
                            Checklist.Item item ->
                                if item.key == key then
                                    Just item.text

                                else
                                    Nothing

                            Checklist.Markdown _ ->
                                Nothing
                    )
                |> List.head
                |> Maybe.withDefault key

        skippedTexts =
            List.map textOf run.repeatedlySkipped
    in
    section [ class "dg-checklist-card dg-checklist-run is-finished" ]
        [ backButton
        , h3 [] [ text run.title ]
        , p [ class "dg-checklist-meta" ]
            [ text ("Started " ++ dayLabel model.state run.startedDay ++ " " ++ run.startedTime ++ " · " ++ countsText (Checklist.counts run)) ]
        , if List.isEmpty skippedTexts then
            text ""

          else
            p [ class "dg-checklist-hint" ]
                [ text ("Skipped in each of the last three runs: " ++ String.join "; " skippedTexts ++ ". Still needed?") ]
        , if run.noteMissing then
            text ""

          else
            div [ class "dg-checklist-question" ]
                [ span [] [ text "Anything to change in the checklist?" ]
                , button [ onClick (Send (Command.OpenNote run.path)) ] [ text "Edit checklist" ]
                ]
        , Checklist.itemsView { mark = Mark run.id, capture = Nothing, readOnly = True } run
        ]


backButton : Html Msg
backButton =
    button [ class "dg-flat-button dg-checklist-back", onClick (Send (Command.ShowRun Nothing)) ] [ text "← All checklists" ]


countsText : Checklist.Counts -> String
countsText tally =
    String.join ", "
        (List.filter (not << String.isEmpty)
            [ String.fromInt tally.done ++ " done"
            , if tally.skipped > 0 then
                String.fromInt tally.skipped ++ " skipped"

              else
                ""
            , if tally.open > 0 then
                String.fromInt tally.open ++ " left open"

              else
                ""
            ]
        )


dayLabel : State -> String -> String
dayLabel state day =
    if day == state.today then
        "today"

    else
        day



-- DECODING


stateDecoder : Decoder State
stateDecoder =
    Decode.map8 State
        (Decode.field "directory" Decode.string)
        (Decode.field "daily" Decode.string)
        (Decode.field "dailyDone" Decode.bool)
        (Decode.field "today" Decode.string)
        (Decode.field "shortLimit" Decode.int)
        (Decode.field "checklists" (Decode.list summaryDecoder))
        (Decode.field "recent" (Decode.list recentDecoder))
        (Decode.field "run" (Decode.nullable Checklist.runDecoder))


summaryDecoder : Decoder Summary
summaryDecoder =
    Decode.map5 Summary
        (Decode.field "path" Decode.string)
        (Decode.field "title" Decode.string)
        (Decode.field "itemCount" Decode.int)
        (Decode.field "lastFinished" Decode.string)
        (Decode.field "openRunId" (Decode.nullable Decode.string))


recentDecoder : Decoder Recent
recentDecoder =
    Decode.map6 Recent
        (Decode.field "id" Decode.string)
        (Decode.field "title" Decode.string)
        (Decode.field "day" Decode.string)
        (Decode.field "done" Decode.int)
        (Decode.field "skipped" Decode.int)
        (Decode.field "open" Decode.int)


hostEventDecoder : Decoder HostEvent
hostEventDecoder =
    Decode.field "type" Decode.string
        |> Decode.andThen
            (\kind ->
                case kind of
                    "checklists" ->
                        Decode.map StateEvent (Decode.field "checklists" stateDecoder)

                    "command-result" ->
                        Decode.map Replied Host.outcomeDecoder

                    _ ->
                        Decode.fail ("Unknown host event: " ++ kind)
            )
