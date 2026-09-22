port module SomedayReview exposing (main)

{-| The Someday/Maybe Review: every parked idea gets a decision. Activate it,
commit to it in the Backlog, keep it for later (optionally waking it up on a
date), or cancel it.
-}

import Browser
import Dict exposing (Dict)
import Gtd.ActionStatus as ActionStatus
import Gtd.Command.SomedayReview as Command exposing (Command)
import Gtd.Data as Data exposing (Project, Snapshot)
import Gtd.Hierarchy as Hierarchy
import Gtd.Host as Host exposing (Requests)
import Gtd.Id exposing (ProjectId)
import Gtd.ProjectStatus as ProjectStatus exposing (ProjectStatus)
import Gtd.Ui as Ui
import Html exposing (Html, article, button, div, h2, h3, header, input, label, p, span, text)
import Html.Attributes exposing (attribute, class, title, type_, value)
import Html.Events exposing (onClick, onInput)
import Json.Decode as Decode exposing (Decoder)
import Json.Encode as Encode


port somedayToHost : Encode.Value -> Cmd msg


port somedayFromHost : (Decode.Value -> msg) -> Sub msg


type alias Model =
    { snapshot : Snapshot
    , wakeDrafts : Dict ProjectId String
    , requests : Requests ()
    , error : Maybe String
    }


type Msg
    = GotHost Decode.Value
    | WakeDateChanged ProjectId String
    | Keep ProjectId
    | Send Command


main : Program Decode.Value Model Msg
main =
    Browser.element
        { init = init
        , update = update
        , subscriptions = \_ -> somedayFromHost GotHost
        , view = view
        }


init : Decode.Value -> ( Model, Cmd Msg )
init flags =
    case Decode.decodeValue (Decode.field "snapshot" Data.snapshotDecoder) flags of
        Ok snapshot ->
            ( { snapshot = snapshot, wakeDrafts = Dict.empty, requests = Host.noRequests, error = Nothing }, Cmd.none )

        Err error ->
            ( { snapshot = Data.empty, wakeDrafts = Dict.empty, requests = Host.noRequests, error = Just (Decode.errorToString error) }
            , Cmd.none
            )


update : Msg -> Model -> ( Model, Cmd Msg )
update msg model =
    case msg of
        GotHost value ->
            receiveHost value model

        WakeDateChanged projectId date ->
            ( { model | wakeDrafts = Dict.insert projectId date model.wakeDrafts }, Cmd.none )

        Keep projectId ->
            send (Command.ReviewSomedayProject projectId (wakeDate model projectId))
                { model | wakeDrafts = Dict.remove projectId model.wakeDrafts }

        Send command ->
            send command model


send : Command -> Model -> ( Model, Cmd Msg )
send command model =
    let
        ( requestId, requests ) =
            Host.issue () model.requests
    in
    ( { model | requests = requests }, somedayToHost (Host.envelope requestId (Command.encode command)) )


type HostEvent
    = SnapshotEvent Snapshot
    | Replied Host.Outcome


receiveHost : Decode.Value -> Model -> ( Model, Cmd Msg )
receiveHost value model =
    case Decode.decodeValue hostEventDecoder value of
        Ok (SnapshotEvent snapshot) ->
            ( { model | snapshot = snapshot }, Cmd.none )

        Ok (Replied outcome) ->
            let
                ( _, requests ) =
                    Host.resolve outcome.requestId model.requests
            in
            case outcome.result of
                Err message ->
                    ( { model | requests = requests, error = Just message }, Cmd.none )

                Ok _ ->
                    ( { model | requests = requests, error = Nothing }, Cmd.none )

        Err error ->
            ( { model | error = Just (Decode.errorToString error) }, Cmd.none )


hostEventDecoder : Decoder HostEvent
hostEventDecoder =
    Decode.field "type" Decode.string
        |> Decode.andThen
            (\kind ->
                case kind of
                    "snapshot" ->
                        Decode.map SnapshotEvent (Decode.field "snapshot" Data.snapshotDecoder)

                    "command-result" ->
                        Decode.map Replied Host.outcomeDecoder

                    _ ->
                        Decode.fail ("Unknown host event: " ++ kind)
            )



-- VIEW


view : Model -> Html Msg
view model =
    let
        pending =
            queue model

        kept =
            model.snapshot.projects
                |> List.filter (\project -> project.status == ProjectStatus.Someday && project.reviewed == Just model.snapshot.today)
                |> List.length
    in
    div [ class "dg-view dg-someday-review" ]
        [ header [ class "dg-view-header" ]
            [ div [] [ h2 [] [ text "Someday/Maybe Review" ], span [ class "dg-count", title "Ideas waiting for a decision" ] [ text (String.fromInt (List.length pending)) ] ]
            ]
        , Ui.maybeView model.error (\message -> div [ class "dg-panel dg-error" ] [ text message ])
        , if List.isEmpty pending then
            div [ class "dg-workflow-complete" ]
                [ span [] [ text "✅" ]
                , h3 [] [ text "Someday/Maybe reviewed" ]
                , p []
                    [ text
                        (if kept > 0 then
                            Ui.plural kept "idea" ++ " kept for later today."

                         else
                            "No Someday/Maybe Projects are waiting for a decision."
                        )
                    ]
                ]

          else
            div [ class "dg-someday-review-body" ]
                [ p [ class "dg-someday-review-intro" ]
                    [ text "Decide on each idea: Activate it now, commit to it in the Backlog, keep it for later (optionally waking it up on a date), or cancel it." ]
                , div [ class "dg-someday-review-list" ] (List.map (viewItem model) pending)
                ]
        ]


viewItem : Model -> Project -> Html Msg
viewItem model project =
    let
        breadcrumb =
            Hierarchy.breadcrumb model.snapshot.projects project

        openCount =
            model.snapshot.actions
                |> List.filter (\action -> action.projectId == Just project.id && ActionStatus.isOpen action.status)
                |> List.length

        decide : ProjectStatus -> Msg
        decide status =
            Send
                (if status == ProjectStatus.Backlog then
                    -- Committing places it at the end of its Backlog queue.
                    Command.MoveSubproject project.id status Nothing

                 else
                    Command.SetProjectStatus project.id status
                )
    in
    article [ class "dg-someday-item", attribute "data-project-card" project.id ]
        [ div [ class "dg-someday-item-main" ]
            [ button
                [ class "dg-someday-item-title dg-flat-button"
                , title ("Open " ++ breadcrumb)
                , onClick (Send (Command.ShowProject project.id))
                ]
                [ text project.title ]
            , if breadcrumb /= project.title then
                div [ class "dg-project-lineage", title breadcrumb ] [ text breadcrumb ]

              else
                text ""
            , div [ class "dg-someday-item-meta" ]
                (Ui.maybeList project.area (\area -> span [] [ text area ])
                    ++ List.map (\tag -> span [] [ text ("#" ++ tag) ]) project.tags
                    ++ [ span [] [ text (Maybe.map ((++) "Reviewed ") project.reviewed |> Maybe.withDefault "Never reviewed") ]
                       , span [] [ text (Ui.plural openCount "open Action") ]
                       ]
                )
            ]
        , div [ class "dg-someday-item-decisions" ]
            [ button [ title "Move to Active", onClick (decide ProjectStatus.Active) ] [ text "Activate" ]
            , button [ title "Commit to it, but not now", onClick (decide ProjectStatus.Backlog) ] [ text "Backlog" ]
            , label [ class "dg-someday-wake", title "Activate automatically on this date" ]
                [ span [] [ text "Wake up" ]
                , input [ type_ "date", value (wakeDate model project.id), onInput (WakeDateChanged project.id) ] []
                ]
            , button [ class "mod-cta", title "Keep it in Someday/Maybe", onClick (Keep project.id) ] [ text "Keep" ]
            , button [ class "dg-someday-drop", title "Cancel this Project (can be undone)", onClick (decide ProjectStatus.Cancelled) ] [ text "Cancel Project" ]
            ]
        ]


{-| Someday/Maybe Projects still waiting for a decision today: the ones never
reviewed first, then the longest since their last review.
-}
queue : Model -> List Project
queue model =
    model.snapshot.projects
        |> List.filter (\project -> project.status == ProjectStatus.Someday && project.reviewed /= Just model.snapshot.today)
        |> List.sortBy (\project -> ( Maybe.withDefault "" project.reviewed, String.toLower (Hierarchy.breadcrumb model.snapshot.projects project) ))


{-| The activation date a Keep would save: the one typed in this review, or the
one the Project already has.
-}
wakeDate : Model -> ProjectId -> String
wakeDate model projectId =
    case Dict.get projectId model.wakeDrafts of
        Just draft ->
            draft

        Nothing ->
            Data.findProject projectId model.snapshot.projects
                |> Maybe.andThen .activateAt
                |> Maybe.withDefault ""
