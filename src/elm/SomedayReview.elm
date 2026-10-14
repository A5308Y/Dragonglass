port module SomedayReview exposing (main)

{-| The Someday/Maybe Review: every parked idea gets a decision. Activate it,
commit to it in the Backlog, keep it for later (optionally waking it up on a
date), or cancel it.

It is the Weekly Review's last step, so once the ideas are decided it lists the
checklists to look over: a list only helps if you remember it when its moment comes.
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
import Html exposing (Html, article, button, div, h2, h3, header, input, label, li, p, section, span, text, ul)
import Html.Attributes exposing (attribute, class, title, type_, value)
import Html.Events exposing (onClick, onInput)
import Json.Decode as Decode exposing (Decoder)
import Json.Encode as Encode


port somedayToHost : Encode.Value -> Cmd msg


port somedayFromHost : (Decode.Value -> msg) -> Sub msg


type alias Model =
    { snapshot : Snapshot
    , checklists : List ReviewChecklist
    , wakeDrafts : Dict ProjectId String
    , requests : Requests ()
    , error : Maybe String
    }


{-| A checklist to look over, with what the settings use it for.
-}
type alias ReviewChecklist =
    { path : String, title : String, lastRun : Maybe String, role : Maybe String }


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
    case Decode.decodeValue flagsDecoder flags of
        Ok ( snapshot, checklists ) ->
            ( { snapshot = snapshot, checklists = checklists, wakeDrafts = Dict.empty, requests = Host.noRequests, error = Nothing }, Cmd.none )

        Err error ->
            ( { snapshot = Data.empty, checklists = [], wakeDrafts = Dict.empty, requests = Host.noRequests, error = Just (Decode.errorToString error) }
            , Cmd.none
            )


flagsDecoder : Decoder ( Snapshot, List ReviewChecklist )
flagsDecoder =
    Decode.map2 Tuple.pair
        (Decode.field "snapshot" Data.snapshotDecoder)
        (Decode.oneOf [ Decode.field "checklists" (Decode.list checklistDecoder), Decode.succeed [] ])


checklistDecoder : Decoder ReviewChecklist
checklistDecoder =
    Decode.map4 ReviewChecklist
        (Decode.field "path" Decode.string)
        (Decode.field "title" Decode.string)
        (Decode.field "lastRun" (Decode.nullable Decode.string))
        (Decode.field "role" (Decode.nullable Decode.string))


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
    | ChecklistsEvent (List ReviewChecklist)
    | Replied Host.Outcome


receiveHost : Decode.Value -> Model -> ( Model, Cmd Msg )
receiveHost value model =
    case Decode.decodeValue hostEventDecoder value of
        Ok (SnapshotEvent snapshot) ->
            ( { model | snapshot = snapshot }, Cmd.none )

        Ok (ChecklistsEvent checklists) ->
            ( { model | checklists = checklists }, Cmd.none )

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

                    "checklists" ->
                        Decode.map ChecklistsEvent (Decode.field "checklists" (Decode.list checklistDecoder))

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
            [ div [] [ h2 [] [ text "Someday/Maybe Review" ], span [ class "dg-count" ] [ text (String.fromInt (List.length pending)) ] ]
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
                , checklistsView model
                ]

          else
            div [ class "dg-someday-review-body" ]
                [ p [ class "dg-someday-review-intro" ]
                    [ text "Decide on each idea: Activate it now, commit to it in the Backlog, keep it for later (optionally waking it up on a date), or cancel it." ]
                , div [ class "dg-someday-review-list" ] (List.map (viewItem model) pending)
                ]
        ]


{-| The checklists, to read over once the ideas are decided: is each still the list you'd
reach for, and do you remember when? Opening one shows the note, to change it right there.
-}
checklistsView : Model -> Html Msg
checklistsView model =
    if List.isEmpty model.checklists then
        text ""

    else
        section [ class "dg-review-checklists" ]
            [ h3 [] [ text "Look over your checklists" ]
            , p []
                [ text "A checklist only helps if you remember it when its moment comes. Is each one still the list you'd reach for? Change or delete the ones that aren't." ]
            , ul [] (List.map checklistRow model.checklists)
            ]


checklistRow : ReviewChecklist -> Html Msg
checklistRow checklist =
    let
        role =
            case checklist.role of
                Just "daily" ->
                    [ "Every day" ]

                Just "focus-reset" ->
                    [ "When your focus is scattered" ]

                _ ->
                    []

        lastRun =
            Maybe.map ((++) "Last run ") checklist.lastRun |> Maybe.withDefault "Not run yet"
    in
    li []
        [ button [ class "dg-review-checklist-title dg-flat-button", onClick (Send (Command.OpenFile checklist.path)) ] [ text checklist.title ]
        , span [ class "dg-review-checklist-meta" ] [ text (String.join " · " (role ++ [ lastRun ])) ]
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

                , onClick (Send (Command.ShowProject project.id))
                ]
                [ text project.title ]
            , if breadcrumb /= project.title then
                div [ class "dg-project-lineage" ] [ text breadcrumb ]

              else
                text ""
            , div [ class "dg-someday-item-meta" ]
                (Ui.maybeList (Hierarchy.area model.snapshot.projects project) (\area -> span [] [ text area ])
                    ++ List.map (\tag -> span [] [ text ("#" ++ tag) ]) project.tags
                    ++ [ span [] [ text (Maybe.map ((++) "Reviewed ") project.reviewed |> Maybe.withDefault "Never reviewed") ]
                       , span [] [ text (Ui.plural openCount "open Action") ]
                       ]
                )
            ]
        , div [ class "dg-someday-item-decisions" ]
            [ button [ onClick (decide ProjectStatus.Active) ] [ text "Activate" ]
            , button [ onClick (decide ProjectStatus.Backlog) ] [ text "Backlog" ]
            , label [ class "dg-someday-wake" ]
                [ span [] [ text "Wake up" ]
                , input [ type_ "date", value (wakeDate model project.id), onInput (WakeDateChanged project.id) ] []
                ]
            , button [ class "mod-cta", onClick (Keep project.id) ] [ text "Keep" ]
            , button [ class "dg-someday-drop", onClick (decide ProjectStatus.Cancelled) ] [ text "Cancel Project" ]
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
