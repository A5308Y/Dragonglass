port module SomedayReview exposing (main)

{-| The Someday/Maybe Review: every parked idea gets a decision. Activate it,
commit to it in the Backlog, keep it for later (optionally waking it up on a
date), or cancel it.

It is the Weekly Review's last step, so once the ideas are decided it lists the
checklists to look over: a list only helps if you remember it when its moment comes.

Sub-projects are listed under their top-level Project, in groups that start folded.
"Keep all" keeps every idea still waiting, with the wake-up dates typed so far.
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
import Html exposing (Html, article, button, div, h2, h3, h4, header, input, label, li, p, section, span, strong, text, ul)
import Html.Attributes exposing (attribute, class, id, type_, value)
import Html.Events exposing (onClick, onInput)
import Json.Decode as Decode exposing (Decoder)
import Json.Encode as Encode
import Set exposing (Set)


port somedayToHost : Encode.Value -> Cmd msg


port somedayFromHost : (Decode.Value -> msg) -> Sub msg


type alias Model =
    { snapshot : Snapshot
    , checklists : List ReviewChecklist
    , wakeDrafts : Dict ProjectId String
    , requests : Requests (Maybe ( ProjectId, Decision ))

    -- What was decided in this session, counted once the host has written it.
    , decisions : Dict ProjectId Decision

    -- Top-level Projects whose group of ideas is unfolded; groups start folded.
    , expanded : Set ProjectId
    , error : Maybe String
    }


type Decision
    = Activated
    | Committed
    | Kept
    | Cancelled


{-| A checklist to look over, with what the settings use it for.
-}
type alias ReviewChecklist =
    { path : String, title : String, lastRun : Maybe String, role : Maybe String }


type Msg
    = GotHost Decode.Value
    | WakeDateChanged ProjectId String
    | Keep ProjectId
    | Decide ProjectId Decision Command
    | Send Command
    | ToggleGroup ProjectId
    | KeepAll


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
            ( initialModel snapshot checklists Nothing, Cmd.none )

        Err error ->
            ( initialModel Data.empty [] (Just (Decode.errorToString error)), Cmd.none )


initialModel : Snapshot -> List ReviewChecklist -> Maybe String -> Model
initialModel snapshot checklists error =
    { snapshot = snapshot
    , checklists = checklists
    , wakeDrafts = Dict.empty
    , requests = Host.noRequests
    , decisions = Dict.empty
    , expanded = Set.empty
    , error = error
    }


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
            send (Just ( projectId, Kept ))
                (Command.ReviewSomedayProject projectId (wakeDate model projectId))
                { model | wakeDrafts = Dict.remove projectId model.wakeDrafts }

        Decide projectId decision command ->
            send (Just ( projectId, decision )) command model

        Send command ->
            send Nothing command model

        ToggleGroup rootId ->
            ( { model
                | expanded =
                    if Set.member rootId model.expanded then
                        Set.remove rootId model.expanded

                    else
                        Set.insert rootId model.expanded
              }
            , Cmd.none
            )

        KeepAll ->
            List.foldl
                (\project ( current, commands ) ->
                    let
                        ( next, command ) =
                            update (Keep project.id) current
                    in
                    ( next, command :: commands )
                )
                ( model, [] )
                (queue model)
                |> Tuple.mapSecond Cmd.batch


send : Maybe ( ProjectId, Decision ) -> Command -> Model -> ( Model, Cmd Msg )
send decision command model =
    let
        ( requestId, requests ) =
            Host.issue decision model.requests
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
                ( decision, requests ) =
                    Host.resolve outcome.requestId model.requests
            in
            case outcome.result of
                Err message ->
                    ( { model | requests = requests, error = Just message }, Cmd.none )

                Ok _ ->
                    ( { model
                        | requests = requests
                        , error = Nothing
                        , decisions =
                            case Maybe.andThen identity decision of
                                Just ( projectId, made ) ->
                                    Dict.insert projectId made model.decisions

                                Nothing ->
                                    model.decisions
                      }
                    , Cmd.none
                    )

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
    in
    div [ class "dg-view dg-someday-review" ]
        [ header [ class "dg-view-header" ]
            [ div [] [ h2 [] [ text "Someday/Maybe Review" ], span [ class "dg-count" ] [ text (String.fromInt (List.length pending)) ] ]
            , if List.isEmpty pending then
                text ""

              else
                div [ class "dg-header-actions" ] [ button [ onClick KeepAll ] [ text "Keep all" ] ]
            ]
        , Ui.maybeView model.error (\message -> div [ class "dg-panel dg-error" ] [ text message ])
        , if List.isEmpty pending then
            doneView model

          else
            div [ class "dg-someday-review-body" ]
                [ p [ class "dg-someday-review-intro" ]
                    [ text "Decide on each idea: Activate it now, commit to it in the Backlog, keep it for later (optionally waking it up on a date), or cancel it. Sub-projects are listed under their top-level Project." ]
                , div [ class "dg-someday-review-list" ] (List.map (viewGroup model) (groups model pending))
                , div [ class "dg-workflow-footer" ]
                    [ div [] [ strong [] [ text "Done for now?" ], span [] [ text " Keep all keeps every idea still waiting for later, with the wake-up dates you typed." ] ]
                    , button [ class "mod-cta", onClick KeepAll ] [ text "Keep all" ]
                    ]
                ]
        ]


{-| The end of the review: what this session decided, then the checklists to look over.
-}
doneView : Model -> Html Msg
doneView model =
    let
        count decision =
            Dict.values model.decisions |> List.filter ((==) decision) |> List.length

        tallies =
            [ ( count Activated, "activated", "Active now" )
            , ( count Committed, "committed", "Committed to the Backlog" )
            , ( count Kept, "kept", "Kept for later" )
            , ( count Cancelled, "cancelled", "Let go" )
            ]
                |> List.filter (\( n, _, _ ) -> n > 0)

        decided =
            Dict.size model.decisions

        keptToday =
            model.snapshot.projects
                |> List.filter (\project -> project.status == ProjectStatus.Someday && project.reviewed == Just model.snapshot.today)
                |> List.length

        summary =
            if decided > 0 then
                "You decided on " ++ Ui.plural decided "idea" ++ ". Everything you parked is where it belongs."

            else if keptToday > 0 then
                Ui.plural keptToday "idea" ++ " kept for later today."

            else
                "No Someday/Maybe Projects are waiting for a decision."
    in
    div [ class "dg-workflow-complete dg-someday-done" ]
        [ span [ class "dg-someday-done-mark" ]
            [ text
                (if decided > 0 then
                    "🎉"

                 else
                    "✅"
                )
            ]
        , h3 [] [ text "Someday/Maybe Review done" ]
        , p [] [ text summary ]
        , if List.isEmpty tallies then
            text ""

          else
            ul [ class "dg-someday-tallies" ]
                (List.map
                    (\( n, key, caption ) ->
                        li [ class ("dg-someday-tally is-" ++ key) ] [ strong [] [ text (String.fromInt n) ], span [] [ text caption ] ]
                    )
                    tallies
                )
        , p [ class "dg-someday-done-note" ] [ text "Every parked idea has had its look. Enjoy the clear head." ]
        , checklistsView model
        ]


{-| Ideas waiting under one top-level Project: the Project itself when it is one of
them, and its Someday/Maybe sub-projects at any depth.
-}
type alias Group =
    { root : Project, items : List Project }


{-| The queue gathered by top-level Project, each group where its first idea stands in
the queue. Inside a group the top-level Project comes first, then the tree in order.
-}
groups : Model -> List Project -> List Group
groups model pending =
    let
        projects =
            model.snapshot.projects

        add project ( order, members ) =
            let
                top =
                    Hierarchy.root projects project
            in
            case Dict.get top.id members of
                Just ( rootProject, items ) ->
                    ( order, Dict.insert top.id ( rootProject, project :: items ) members )

                Nothing ->
                    ( top.id :: order, Dict.insert top.id ( top, [ project ] ) members )

        ( rootOrder, grouped ) =
            List.foldl add ( [], Dict.empty ) pending
    in
    rootOrder
        |> List.reverse
        |> List.filterMap (\rootId -> Dict.get rootId grouped)
        |> List.map
            (\( rootProject, items ) ->
                { root = rootProject
                , items =
                    List.sortBy
                        (\project ->
                            ( if project.id == rootProject.id then
                                0

                              else
                                1
                            , String.toLower (Hierarchy.breadcrumb projects project)
                            )
                        )
                        items
                }
            )


viewGroup : Model -> Group -> Html Msg
viewGroup model group =
    case group.items of
        [ only ] ->
            if only.id == group.root.id then
                viewItem model False only

            else
                viewFolded model group

        _ ->
            viewFolded model group


viewFolded : Model -> Group -> Html Msg
viewFolded model group =
    let
        open =
            Set.member group.root.id model.expanded

        headingId =
            "dg-someday-group-" ++ group.root.id

        rootNote =
            if List.any (\project -> project.id == group.root.id) group.items then
                []

            else
                [ span [ class "dg-someday-group-status" ] [ text (ProjectStatus.label group.root.status) ] ]
    in
    section [ class "dg-someday-group", attribute "aria-labelledby" headingId ]
        [ h4 [ class "dg-someday-group-heading", id headingId ]
            [ button
                [ class "dg-disclosure dg-someday-group-toggle dg-flat-button"
                , attribute "aria-expanded" (Ui.boolAttribute open)
                , onClick (ToggleGroup group.root.id)
                ]
                [ span [ class "dg-someday-group-title" ]
                    ([ text
                        ((if open then
                            "▾ "

                          else
                            "▸ "
                         )
                            ++ group.root.title
                        )
                     ]
                        ++ rootNote
                    )
                , span [ class "dg-review-count" ] [ text (Ui.plural (List.length group.items) "idea") ]
                ]
            ]
        , if open then
            div [ class "dg-someday-group-items" ] (List.map (viewItem model True) group.items)

          else
            text ""
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


{-| One idea and its decisions. In a group the top-level Project is in the heading, so
the lineage starts below it.
-}
viewItem : Model -> Bool -> Project -> Html Msg
viewItem model inGroup project =
    let
        lineage =
            ancestorTitles model.snapshot.projects project
                |> List.drop
                    (if inGroup then
                        1

                     else
                        0
                    )

        openCount =
            model.snapshot.actions
                |> List.filter (\action -> action.projectId == Just project.id && ActionStatus.isOpen action.status)
                |> List.length

        decide : ProjectStatus -> Decision -> Msg
        decide status decision =
            Decide project.id
                decision
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
            , if List.isEmpty lineage then
                text ""

              else
                div [ class "dg-project-lineage" ] [ text ("In " ++ String.join Hierarchy.separator lineage) ]
            , div [ class "dg-someday-item-meta" ]
                (Ui.maybeList (Hierarchy.area model.snapshot.projects project) (\area -> span [] [ text area ])
                    ++ List.map (\tag -> span [] [ text ("#" ++ tag) ]) project.tags
                    ++ [ span [] [ text (Maybe.map ((++) "Reviewed ") project.reviewed |> Maybe.withDefault "Never reviewed") ]
                       , span [] [ text (Ui.plural openCount "open Action") ]
                       ]
                )
            ]
        , div [ class "dg-someday-item-decisions" ]
            [ button [ onClick (decide ProjectStatus.Active Activated) ] [ text "Activate" ]
            , button [ onClick (decide ProjectStatus.Backlog Committed) ] [ text "Backlog" ]
            , label [ class "dg-someday-wake" ]
                [ span [] [ text "Wake up" ]
                , input [ type_ "date", value (wakeDate model project.id), onInput (WakeDateChanged project.id) ] []
                ]
            , button [ class "mod-cta", onClick (Keep project.id) ] [ text "Keep" ]
            , button [ class "dg-someday-drop", onClick (decide ProjectStatus.Cancelled Cancelled) ] [ text "Cancel Project" ]
            ]
        ]


{-| The titles of a Project's parents, top-level first.
-}
ancestorTitles : List Project -> Project -> List String
ancestorTitles projects project =
    let
        walk seen current titles =
            case current.parentProjectId |> Maybe.andThen (\parentId -> Data.findProject parentId projects) of
                Just parent ->
                    if Set.member parent.id seen then
                        titles

                    else
                        walk (Set.insert parent.id seen) parent (parent.title :: titles)

                Nothing ->
                    titles
    in
    walk (Set.singleton project.id) project []


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
